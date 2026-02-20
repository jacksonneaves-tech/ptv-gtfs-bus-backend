import express from "express";
import fetch from "node-fetch";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "1a9699bf-54d2-42a4-a170-5416f7f6993a";

const GTFS_URL =
  "https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/bus/vehicle-positions";

app.get("/", (req, res) => {
  res.send("PTV GTFS Backend Running");
});

app.get("/debug", async (req, res) => {
  try {
    const response = await fetch(GTFS_URL, {
      headers: { KeyId: API_KEY }
    });

    const buffer = await response.arrayBuffer();

    const feed =
      GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
        new Uint8Array(buffer)
      );

    const vehicles = feed.entity
      .filter(e => e.vehicle)
      .slice(0, 20)
      .map(e => ({
        vehicleId: e.vehicle.vehicle?.id || null,
        vehicleLabel: e.vehicle.vehicle?.label || null,
        routeId: e.vehicle.trip?.routeId || null,
        tripId: e.vehicle.trip?.tripId || null,
        latitude: e.vehicle.position?.latitude || null,
        longitude: e.vehicle.position?.longitude || null,
        timestamp: e.vehicle.timestamp || null
      }));

    res.json(vehicles);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "decode_failed" });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
