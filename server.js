import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import cors from "cors";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const app = express();

// ✅ Enable CORS for all origins
app.use(cors({
  origin: "*"
}));

const PORT = process.env.PORT || 3000;

const API_KEY = "1a9699bf-54d2-42a4-a170-5416f7f6993a";

const GTFS_URL =
  "https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/bus/vehicle-positions";

const fleetMap = JSON.parse(
  fs.readFileSync("./fleet_map.json", "utf8")
);

// Get operators for a fleet number
app.get("/operators/:fleet", (req, res) => {
  const fleet = req.params.fleet.trim();
  const matches = fleetMap.filter(b => b.fleet === fleet);

  if (matches.length === 0) {
    return res.json({ error: "fleet_not_found" });
  }

  res.json({
    fleet,
    operators: matches.map(b => b.operator)
  });
});

// Get bus location
app.get("/bus/:fleet/:operator", async (req, res) => {
  try {
    const fleet = req.params.fleet.trim();
    const operator = req.params.operator.trim();

    const match = fleetMap.find(
      b => b.fleet === fleet && b.operator === operator
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

    const vehicle = feed.entity
      .filter(e => e.vehicle)
      .find(e => e.vehicle.vehicle?.id === match.rego);

    if (!vehicle) {
      return res.json({ error: "bus_not_active" });
    }

    const timestamp = vehicle.vehicle.timestamp?.low || 0;
    const now = Math.floor(Date.now() / 1000);

    const isLive = now - timestamp < 120;

    res.json({
      fleet,
      operator,
      registration: match.rego,
      routeId: vehicle.vehicle.trip?.routeId,
      latitude: vehicle.vehicle.position?.latitude,
      longitude: vehicle.vehicle.position?.longitude,
      timestamp,
      live: isLive
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "server_error" });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
