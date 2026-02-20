import express from "express";
import fetch from "node-fetch";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "YOUR_API_KEY";

const GTFS_URL =
  "https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/bus/vehicle-positions";

app.get("/", (req, res) => {
  res.send("GTFS Bus Backend Running");
});

app.get("/debug", async (req, res) => {
  try {
    const response = await fetch(GTFS_URL, {
      headers: { "KeyId": API_KEY }
    });

    const buffer = await response.arrayBuffer();

    const feed =
      GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
        new Uint8Array(buffer)
      );

    const sample = feed.entity.slice(0, 10).map(e => ({
      vehicleId: e.vehicle?.vehicle?.id,
      vehicleLabel: e.vehicle?.vehicle?.label,
      routeId: e.vehicle?.trip?.routeId
    }));

    res.json(sample);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "debug_failed" });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
