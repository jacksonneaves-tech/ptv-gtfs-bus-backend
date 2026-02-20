import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "1a9699bf-54d2-42a4-a170-5416f7f6993a";

const GTFS_URL =
  "https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/bus/vehicle-positions";

// Load fleet mapping file
const fleetMap = JSON.parse(
  fs.readFileSync("./fleet_map.json", "utf8")
);

app.get("/bus/:fleetNumber", async (req, res) => {
  try {
    const fleetNumber = req.params.fleetNumber.trim();

    // Find registration from fleet map
    const match = fleetMap.find(
      b => b.fleet === fleetNumber
    );

    if (!match) {
      return res.json({ error: "fleet_not_found" });
    }

    const registration = match.rego;

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
      .find(e => e.vehicle.vehicle?.id === registration);

    if (!vehicle) {
      return res.json({ error: "bus_not_active" });
    }

    res.json({
      fleetNumber,
      registration,
      routeId: vehicle.vehicle.trip?.routeId,
      latitude: vehicle.vehicle.position?.latitude,
      longitude: vehicle.vehicle.position?.longitude,
      timestamp: vehicle.vehicle.timestamp?.low
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "server_error" });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
