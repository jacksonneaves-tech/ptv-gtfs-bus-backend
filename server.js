import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import cors from "cors";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { createClient } from "@supabase/supabase-js";
import * as signalR from "@microsoft/signalr";

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

/*
=================================================
PREMIUM SIGNALR CACHE (VIC ONLY)
=================================================
*/

const premiumCache = new Map();

function extractFleet(externalId) {
  if (!externalId) return null;

  const parts = externalId.split("-");
  if (parts.length < 2) return null;

  const tail = parts[1];

  // Remove leading zeros
  const cleaned = tail.replace(/^0+/, "");

  return cleaned || null;
}

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
=================================================
PREMIUM SIGNALR CONNECTION
=================================================
*/

async function startPremiumConnection() {
  try {
    console.log("Connecting to Premium SignalR...");

    const token = Buffer
      .from(`${process.env.PREMIUM_USER}:${process.env.PREMIUM_PASS}`)
      .toString("base64");

    const connection = new signalR.HubConnectionBuilder()
      .withUrl(
        `https://${process.env.PREMIUM_HOST}/Tmix.Cap.ExternalApi/signalr/hubs`,
        {
          accessTokenFactory: () => token
        }
      )
      .withAutomaticReconnect()
      .build();

    connection.on("OnMsgs", (msgs) => {

      msgs.forEach(msg => {

        if (msg.Header?.MessageName !== "MsgVehicleEvent") return;

        const externalId = msg.Message?.Vehicle?.ExternalId;
        const lat = msg.Message?.Position?.Latitude;
        const lng = msg.Message?.Position?.Longitude;

        if (!externalId || lat == null || lng == null) return;

        const fleet = extractFleet(externalId);
        if (!fleet) return;

        // Store temporarily using fleet as key (we convert later)
        premiumCache.set(fleet, {
          latitude: lat,
          longitude: lng,
          last_seen: Date.now()
        });

      });

    });

    await connection.start();

    await connection.invoke("Subscribe", {
      Version: "1.0",
      MessageFilter: {}
    });

    console.log("Premium SignalR connected successfully");

  } catch (err) {
    console.error("Premium connection error:", err);
  }
}

/*
----------------------------------------
START SERVER
----------------------------------------
*/
startPremiumConnection();

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
