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

      const rego =
        entity.vehicle.vehicle?.licensePlate ||
        entity.vehicle.vehicle?.id;

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
GET NSW BUS (FROM DATABASE)
----------------------------------------
*/

app.get("/nsw/:input", async (req, res) => {
  try {
    const userInput = req.params.input.trim().toUpperCase();

    const normalize = (str) =>
      str?.toUpperCase().replace(/[^A-Z0-9]/g, "");

    const cleanInput = normalize(userInput);

    const { data } = await supabase
      .from("vehicles")
      .select("*")
      .eq("state", "NSW");

    if (!data) {
      return res.json({ error: "nsw_not_found" });
    }

    const match = data.find(v =>
      normalize(v.rego).includes(cleanInput)
    );

    if (!match) {
      return res.json({ error: "nsw_not_found" });
    }

   const now = Date.now();
const isLive = now - match.last_seen < 120000;

return res.json({
  latitude: match.latitude,
  longitude: match.longitude,
  timestamp: match.last_seen,
  status: isLive ? "live" : "offline"
});

  } catch (error) {
    console.error("NSW lookup error:", error);
    res.status(500).json({ error: "nsw_server_error" });
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
