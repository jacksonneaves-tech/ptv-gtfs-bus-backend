import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import cors from "cors";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors({ origin: "*" }));

const PORT = process.env.PORT || 3000;

const API_KEY = "1a9699bf-54d2-42a4-a170-5416f7f6993a";

const VIC_GTFS_URL =
  "https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/bus/vehicle-positions";

const NSW_GTFS_URL =
  "https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/buses";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const fleetMap = JSON.parse(
  fs.readFileSync("./fleet_map.json", "utf8")
);

const SKYBUS_REGOS = [
"BS03XB","XS38AA","BS03XC","XS39AA","0081AO","130FB5","BS01DH",
"XT44AI","XT46AI","XT94AK","XT59AM","XT20BJ","XT81BG","9025AO",
"9028AO","XT53CC","XT55CC","BS00OG","BS00OE","BS01LS","BS01LT",
"BS01LU","BS01LV","BS01WX","BS01WY","BS02IS","BS02IT","BS02IW",
"BS02KH","BS02KI","BS02KJ","BS02YN","BS04BC","BS04BD","BS04NV",
"BS04NW","BS08PP","BS08PO","BS08BI","BS08BH","BS09NK","BS12HF",
"BS08PQ","BS13YA","BS04BA","BS04BB","BS04NN","BS04NO","BS04SZ",
"BS04TA","BS04TB","BS04TC","BS04TD","BS04TE","BS04TF","BS04TG",
"BS04TH","BS04TI","BS04TJ","BS06OG","BS06OH","BS06OZ","BS14JF",
"BS14JG","BS14JJ","BS14JH","BS14JE","BS14JI"
];

/*
=================================================
GENERIC BATCH UPSERT FUNCTION
=================================================
*/

async function batchUpsert(vehicles) {
  const chunkSize = 500;

  for (let i = 0; i < vehicles.length; i += chunkSize) {
    const chunk = vehicles.slice(i, i + chunkSize);

    const { error } = await supabase
      .from("vehicles")
      .upsert(chunk, { onConflict: "rego" });

    if (error) {
      console.error("Upsert error:", error);
    }
  }
}

/*
=================================================
VIC POLLING
=================================================
*/

async function pollVicGTFS() {
  try {
    console.log("Polling VIC GTFS...");

    const response = await fetch(VIC_GTFS_URL, {
      headers: { KeyId: API_KEY }
    });

    const buffer = await response.arrayBuffer();

    const feed =
      GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
        new Uint8Array(buffer)
      );

    const now = Date.now();
    const vehicleMap = new Map();

    for (const entity of feed.entity) {
      if (!entity.vehicle) continue;

      const rego = entity.vehicle.vehicle?.id;
      const latitude = entity.vehicle.position?.latitude;
      const longitude = entity.vehicle.position?.longitude;

      if (!rego || latitude == null || longitude == null) continue;

      vehicleMap.set(rego, {
        rego,
        latitude,
        longitude,
        last_seen: now,
        state: "VIC"
      });
    }

    const vehicles = Array.from(vehicleMap.values());

    console.log(`Caching ${vehicles.length} VIC buses`);

    await batchUpsert(vehicles);

  } catch (err) {
    console.error("VIC Polling Error:", err);
  }
}

/*
=================================================
NSW POLLING
=================================================
*/

async function pollNswGTFS() {
  try {
    console.log("Polling NSW GTFS...");

    const response = await fetch(NSW_GTFS_URL, {
      headers: {
        Authorization: `apikey ${process.env.TFNSW_API_KEY}`,
        Accept: "application/x-protobuf"
      }
    });

    const buffer = await response.arrayBuffer();

    const feed =
      GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
        new Uint8Array(buffer)
      );

    const now = Date.now();
    const vehicleMap = new Map();

    for (const entity of feed.entity) {
      if (!entity.vehicle) continue;

      const rawRego = entity.vehicle.vehicle?.licensePlate;

if (!rawRego) continue;

// Clean and validate rego
const rego = rawRego.trim().toUpperCase();

// Reject weird internal IDs
if (!/^[A-Z0-9]{4,8}$/.test(rego)) continue;

      const latitude = entity.vehicle.position?.latitude;
      const longitude = entity.vehicle.position?.longitude;

      if (!rego || latitude == null || longitude == null) continue;

      vehicleMap.set(rego, {
        rego,
        latitude,
        longitude,
        last_seen: now,
        state: "NSW"
      });
    }

    const vehicles = Array.from(vehicleMap.values());

    console.log(`Caching ${vehicles.length} NSW buses`);

    await batchUpsert(vehicles);

  } catch (err) {
    console.error("NSW Polling Error:", err);
  }
}

/*
=================================================
START POLLING
=================================================
*/

setInterval(pollVicGTFS, 60000);
setInterval(pollNswGTFS, 60000);

pollVicGTFS();
pollNswGTFS();

/*
----------------------------------------
GET OPERATORS FOR FLEET (VIC)
----------------------------------------
*/

app.get("/operators/:fleet", (req, res) => {
  const fleet = req.params.fleet.trim();

  const matches = fleetMap.filter(
    b => String(b.fleet).trim() === fleet
  );

  if (matches.length === 0) {
    return res.json({ error: "fleet_not_found" });
  }

  res.json({
    fleet,
    operators: matches.map(b => b.operator)
  });
});

/*
----------------------------------------
GET BUS (VIC) — DATABASE
----------------------------------------
*/

app.get("/bus/:fleet/:operator", async (req, res) => {
  try {
    const fleet = req.params.fleet.trim();
    const operator = req.params.operator.trim().toLowerCase();

    const match = fleetMap.find(
      b =>
        String(b.fleet).trim() === fleet &&
        b.operator.toLowerCase() === operator
    );

    if (!match) {
      return res.json({ error: "fleet_not_found" });
    }

    const { data } = await supabase
      .from("vehicles")
      .select("*")
      .eq("rego", match.rego)
      .single();

    if (!data) {
      return res.json({
        error: "bus_not_active",
        searchingForRego: match.rego
      });
    }

    const now = Date.now();
    const isLive = now - data.last_seen < 120000;

    return res.json({
  fleet,
  operator: match.operator,
  rego: match.rego,
  latitude: data.latitude,
  longitude: data.longitude,
  timestamp: data.last_seen,
  status: isLive ? "live" : "offline"
});

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "server_error" });
  }
});

/*
----------------------------------------
GET NSW BUS (SMART MATCHING)
----------------------------------------
*/

app.get("/nsw/:input", async (req, res) => {
  try {
    const rawInput = req.params.input.trim();

    // Ensure only 4 digits allowed
    if (!/^\d{4}$/.test(rawInput)) {
      return res.json({ error: "nsw_not_found" });
    }

    const cleanInput = rawInput;

    // Let Supabase do the matching
    const { data, error } = await supabase
      .from("vehicles")
      .select("*")
      .eq("state", "NSW")
      .ilike("rego", `%${cleanInput}%`);

    if (error) {
      console.error("NSW DB error:", error);
      return res.json({ error: "nsw_not_found" });
    }

    if (!data || data.length === 0) {
      return res.json({ error: "nsw_not_found" });
    }

    if (data.length === 1) {
      const bus = data[0];
      const now = Date.now();
      const isLive = now - bus.last_seen < 120000;

      return res.json({
        single: true,
        rego: bus.rego,
        latitude: bus.latitude,
        longitude: bus.longitude,
        timestamp: bus.last_seen,
        status: isLive ? "live" : "offline"
      });
    }

    // Multiple matches
    return res.json({
      multiple: true,
      options: data.map(v => v.rego)
    });

  } catch (err) {
    console.error("NSW lookup error:", err);
    res.status(500).json({ error: "nsw_server_error" });
  }
});

/*
----------------------------------------
GET NSW BUS BY EXACT REGO
----------------------------------------
*/

app.get("/nsw-exact/:rego", async (req, res) => {
  try {
    const rego = req.params.rego.trim().toUpperCase();

    const { data } = await supabase
      .from("vehicles")
      .select("*")
      .eq("rego", rego)
      .eq("state", "NSW")
      .single();

    if (!data) {
      return res.json({ error: "nsw_not_found" });
    }

    const now = Date.now();
    const isLive = now - data.last_seen < 120000;

    return res.json({
      latitude: data.latitude,
      longitude: data.longitude,
      timestamp: data.last_seen,
      status: isLive ? "live" : "offline"
    });

  } catch (error) {
    console.error("NSW exact lookup error:", error);
    res.status(500).json({ error: "nsw_server_error" });
  }
});

/*
----------------------------------------
GET NEAREST BUS (VIC + NSW)
----------------------------------------
*/

app.get("/nearest", async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);

    if (isNaN(lat) || isNaN(lng)) {
      return res.json({ error: "invalid_coordinates" });
    }

    // Get all cached vehicles
    const { data, error } = await supabase
      .from("vehicles")
      .select("*");

    if (error || !data || data.length === 0) {
      return res.json({ error: "no_vehicles_available" });
    }

    let nearest = null;
    let minDistance = Infinity;

    for (const vehicle of data) {
      if (!vehicle.latitude || !vehicle.longitude) continue;

      const distance = Math.sqrt(
        Math.pow(vehicle.latitude - lat, 2) +
        Math.pow(vehicle.longitude - lng, 2)
      );

      if (distance < minDistance) {
        minDistance = distance;
        nearest = vehicle;
      }
    }

    if (!nearest) {
      return res.json({ error: "no_vehicle_found" });
    }

    const now = Date.now();
    const isLive = now - nearest.last_seen < 120000;

    // Lookup fleet number for VIC buses
let fleet = null;

if (nearest.state === "VIC") {
  const match = fleetMap.find(
    b => b.rego.trim().toUpperCase() === nearest.rego.trim().toUpperCase()
  );

  if (match) {
    fleet = match.fleet;
  }
}

return res.json({
  rego: nearest.rego,
  fleet: fleet,
  state: nearest.state,
  latitude: nearest.latitude,
  longitude: nearest.longitude,
  timestamp: nearest.last_seen,
  status: isLive ? "live" : "offline"
});

  } catch (err) {
    console.error("Nearest lookup error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

/*
----------------------------------------
DEBUG: RAW GTFS ENTITY
----------------------------------------
*/

app.get("/debug/vic/raw", async (req, res) => {
  try {

    const response = await fetch(VIC_GTFS_URL, {
      headers: { KeyId: API_KEY }
    });

    const buffer = await response.arrayBuffer();

    const feed =
      GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
        new Uint8Array(buffer)
      );

    res.json(feed.entity[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "debug_failed" });
  }
});

/*
----------------------------------------
DEBUG: FIND NON-STANDARD VEHICLE IDS
----------------------------------------
*/

app.get("/debug/vic/non-standard-ids", async (req, res) => {

  try {

    const response = await fetch(VIC_GTFS_URL, {
      headers: { KeyId: API_KEY }
    });

    const buffer = await response.arrayBuffer();

    const feed =
      GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
        new Uint8Array(buffer)
      );

    const normalRegos = [];
    const anomalies = [];

    const modernPattern = /^BS\d{2}[A-Z]{2}$/;
    const oldPattern = /^\d{4}AO$/;

    for (const entity of feed.entity) {

      if (!entity.vehicle) continue;

      const id = entity.vehicle.vehicle?.id;

      if (!id) continue;

      const clean = id.trim().toUpperCase();

      if (modernPattern.test(clean) || oldPattern.test(clean)) {

        normalRegos.push(clean);

      } else {

        anomalies.push({
          id: clean,
          route: entity.vehicle.trip?.routeId,
          tripId: entity.vehicle.trip?.tripId,
          latitude: entity.vehicle.position?.latitude,
          longitude: entity.vehicle.position?.longitude
        });

      }

    }

    res.json({
      totalVehicles: feed.entity.length,
      normalRegosDetected: normalRegos.length,
      anomaliesDetected: anomalies.length,
      anomalies
    });

  } catch (err) {

    console.error(err);
    res.status(500).json({ error: "scan_failed" });

  }

});

/*
----------------------------------------
START SERVER
----------------------------------------
*/

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
