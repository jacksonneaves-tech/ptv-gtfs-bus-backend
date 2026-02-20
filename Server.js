import express from "express";
import fetch from "node-fetch";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const app = express();
const PORT = process.env.PORT || 3000;

/* ===============================
   🔐 OpenData API Key
   =============================== */

const API_KEY = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJqdGkiOiJ2UDZiSkhka1lhQ3lRV3BDSUp1WnVhdUpmdHNnellucUZqNDgzYU5ZMGhjIiwiaWF0IjoxNzcxNTc5MTIwfQ.KpzxhHRqxRNxH-0pNAQSSWNv05cRHkn-r6rdTF0ItYg";

/* ==========================================
   OpenData GTFS-RT Bus Vehicle Positions
   ========================================== */

const GTFS_URL =
  "https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/bus/vehicle-positions";

/* ===============================
   Health Check
   =============================== */

app.get("/", (req, res) => {
  res.send("GTFS Bus Backend Running");
});

/* ===============================
   Bus Lookup Endpoint
   =============================== */

app.get("/bus/:number", async (req, res) => {
  const busNumber = req.params.number;

  try {
    const response = await fetch(GTFS_URL, {
      headers: {
        "KeyId": API_KEY
      }
    });

    const buffer = await response.arrayBuffer();

    const feed =
      GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
        new Uint8Array(buffer)
      );

    const matches = feed.entity
      .filter(e =>
        e.vehicle &&
        e.vehicle.vehicle &&
        e.vehicle.vehicle.label == busNumber
      )
      .map(e => ({
        operator: e.vehicle.trip?.routeId || "Unknown",
        lat: e.vehicle.position.latitude,
        lon: e.vehicle.position.longitude,
        timestamp: e.vehicle.timestamp.low || e.vehicle.timestamp,
        route: e.vehicle.trip?.routeId || "Unknown"
      }));

    if (matches.length === 0) {
      return res.json({ error: "not_found" });
    }

    res.json(matches);

  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({ error: "server_error" });
  }
});

/* ===============================
   Start Server
   =============================== */

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
