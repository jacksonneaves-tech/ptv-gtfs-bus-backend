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

// ==============================
// SUPABASE CONNECTION
// ==============================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ==============================
// LOAD FLEET MAP
// ==============================

const fleetMap = JSON.parse(
  fs.readFileSync("./fleet_map.json", "utf8")
);

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
GET BUS LOCATION (VIC)
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

    const response = await fetch(GTFS_URL, {
      headers: { KeyId: API_KEY }
    });

    const buffer = await response.arrayBuffer();

    const feed =
      GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
        new Uint8Array(buffer)
      );

    const normalize = (rego) =>
      rego?.toUpperCase().replace(/^0+/, "");

    const vehicle = feed.entity.find(e =>
      e.vehicle &&
      e.vehicle.vehicle &&
      normalize(e.vehicle.vehicle.id) === normalize(match.rego)
    );

    // ======================
    // IF LIVE
    // ======================
    if (vehicle) {
      const latitude = vehicle.vehicle.position?.latitude;
      const longitude = vehicle.vehicle.position?.longitude;
      const now = Date.now();

      // UPSERT into Supabase
      await supabase
        .from("vehicles")
        .upsert({
          rego: match.rego,
          latitude,
          longitude,
          last_seen: now,
          fleet,
          operator: match.operator
        });

      return res.json({
        status: "live",
        fleet,
        operator: match.operator,
        rego: match.rego,
        routeId: vehicle.vehicle.trip?.routeId || null,
        latitude,
        longitude,
        timestamp: vehicle.vehicle.timestamp
      });
    }

    // ======================
    // IF OFFLINE → CHECK DB
    // ======================

    const { data } = await supabase
      .from("vehicles")
      .select("*")
      .eq("rego", match.rego)
      .single();

    if (data) {
      return res.json({
        status: "offline",
        fleet,
        operator: data.operator,
        rego: match.rego,
        latitude: data.latitude,
        longitude: data.longitude,
        lastSeen: data.last_seen
      });
    }

    return res.json({
      error: "bus_not_active",
      searchingForRego: match.rego
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "server_error" });
  }
});

/*
----------------------------------------
NSW ENDPOINT (UNCHANGED)
----------------------------------------
*/
app.get("/nsw/:input", async (req, res) => {
  try {
    const userInput = req.params.input.trim().toUpperCase();

    if (!process.env.TFNSW_API_KEY) {
      return res.status(500).json({ error: "missing_tfnsw_api_key" });
    }

    const response = await fetch(
      "https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/buses",
      {
        headers: {
          Authorization: `apikey ${process.env.TFNSW_API_KEY}`,
          Accept: "application/x-protobuf"
        }
      }
    );

    const buffer = await response.arrayBuffer();

    const feed =
      GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
        new Uint8Array(buffer)
      );

    const normalize = (str) =>
      str?.toUpperCase().replace(/[^A-Z0-9]/g, "");

    const cleanInput = normalize(userInput);

    let match = null;

    for (const entity of feed.entity) {
      if (!entity.vehicle) continue;

      const rego =
        normalize(entity.vehicle.vehicle?.licensePlate) ||
        normalize(entity.vehicle.vehicle?.id);

      if (!rego) continue;

      if (rego.includes(cleanInput)) {
        match = entity.vehicle;
        break;
      }
    }

    if (!match) {
      return res.json({ error: "nsw_not_found" });
    }

    res.json({
      state: "NSW",
      rego:
        match.vehicle?.licensePlate ||
        match.vehicle?.id,
      latitude: match.position?.latitude,
      longitude: match.position?.longitude,
      timestamp: match.timestamp
    });

  } catch (error) {
    console.error("NSW ERROR:", error);
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
