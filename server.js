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

const GTFS_URL =
  "https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/bus/vehicle-positions";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const fleetMap = JSON.parse(
  fs.readFileSync("./fleet_map.json", "utf8")
);

/*
=================================================
BACKGROUND POLLING — CACHE ALL VIC BUSES
=================================================
*/

async function pollVicGTFS() {
  try {
    console.log("Polling VIC GTFS...");

    const response = await fetch(GTFS_URL, {
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

  // If duplicate rego appears, latest one overwrites previous
  vehicleMap.set(rego, {
    rego,
    latitude,
    longitude,
    last_seen: now
  });
}

const vehiclesToUpsert = Array.from(vehicleMap.values());

    console.log(`Preparing to cache ${vehiclesToUpsert.length} buses`);

    // ✅ Batch in chunks of 500
    const chunkSize = 500;
    let chunkCounter = 0;

    // Process in batches
    for (let i = 0; i < vehiclesToUpsert.length; i += chunkSize) {
      const chunk = vehiclesToUpsert.slice(i, i + chunkSize);
      chunkCounter++;

      console.log(`Upserting chunk ${chunkCounter}...`);

      const { error } = await supabase
        .from("vehicles")
        .upsert(chunk, { onConflict: "rego" });

      if (error) {
        console.error(`Error in upsert chunk ${chunkCounter}:`, error);
      } else {
        console.log(`Successfully cached chunk ${chunkCounter}`);
      }
    }

    console.log(`Cached ${vehiclesToUpsert.length} VIC buses`);

  } catch (err) {
    console.error("VIC Polling Error:", err);
  }
}

// Poll every 60 seconds
setInterval(pollVicGTFS, 60000);

// Run immediately on startup
pollVicGTFS();

/*
----------------------------------------
GET OPERATORS
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
GET BUS (VIC) — DATABASE ONLY
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

    const normalize = (rego) =>
      rego?.toUpperCase().replace(/^0+/, "");

    const { data } = await supabase
      .from("vehicles")
      .select("*");

    if (!data) {
      return res.json({
        error: "bus_not_active",
        searchingForRego: match.rego
      });
    }

    const found = data.find(
      v => normalize(v.rego) === normalize(match.rego)
    );

    if (!found) {
      return res.json({
        error: "bus_not_active",
        searchingForRego: match.rego
      });
    }

    const now = Date.now();
    const isLive = now - found.last_seen < 120000;

    return res.json({
      status: isLive ? "live" : "offline",
      fleet,
      operator: match.operator,
      rego: match.rego,
      latitude: found.latitude,
      longitude: found.longitude,
      lastSeen: found.last_seen
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "server_error" });
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
