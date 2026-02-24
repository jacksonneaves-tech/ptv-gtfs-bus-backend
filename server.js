import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import cors from "cors";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const app = express();

// ✅ Enable CORS (required for GitHub Pages frontend)
app.use(cors({ origin: "*" }));

const PORT = process.env.PORT || 3000;

// 🔐 Replace with your REAL PTV subscription key
const API_KEY = "1a9699bf-54d2-42a4-a170-5416f7f6993a";

const GTFS_URL =
  "https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/bus/vehicle-positions";

// ✅ Load fleet mapping file
const fleetMap = JSON.parse(
  fs.readFileSync("./fleet_map.json", "utf8")
);

/*
----------------------------------------
GET OPERATORS FOR FLEET
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
GET BUS LOCATION
----------------------------------------
*/
app.get("/bus/:fleet/:operator", async (req, res) => {
  try {
    const fleet = req.params.fleet.trim();
    const operator = req.params.operator.trim().toLowerCase();

    // 🔎 Find fleet + operator match in JSON
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

    // ✅ Normalize regos (removes leading zeros)
    const normalize = (rego) =>
      rego?.toUpperCase().replace(/^0+/, "");

    const vehicle = feed.entity.find(e =>
      e.vehicle &&
      e.vehicle.vehicle &&
      normalize(e.vehicle.vehicle.id) === normalize(match.rego)
    );

    if (!vehicle) {
      return res.json({
        error: "bus_not_active",
        searchingForRego: match.rego
      });
    }

    res.json({
      fleet,
      operator: match.operator,
      rego: match.rego,
      routeId: vehicle.vehicle.trip?.routeId || null,
      latitude: vehicle.vehicle.position?.latitude,
      longitude: vehicle.vehicle.position?.longitude,
      timestamp: vehicle.vehicle.timestamp
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "server_error" });
  }
});

/*
----------------------------------------
GET NSW BUS BY REGO
----------------------------------------
*/
app.get("/nsw/:digits", async (req, res) => {
  try {
    const digits = req.params.digits.trim();
    const fullRego = digits + "MO";

    const response = await fetch(
      "https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/buses",
      {
        headers: {
          Authorization: `apikey ${process.env.TFNSW_API_KEY}`
        }
      }
    );

    const buffer = await response.arrayBuffer();

    const feed =
      GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
        new Uint8Array(buffer)
      );

    const match = feed.entity
      .filter(e => e.vehicle)
      .find(e =>
        e.vehicle.vehicle?.id?.toUpperCase().includes(fullRego)
      );

    if (!match) {
      return res.json({ error: "nsw_not_found" });
    }

    res.json({
      state: "NSW",
      rego: fullRego,
      latitude: match.vehicle.position.latitude,
      longitude: match.vehicle.position.longitude,
      timestamp: match.vehicle.timestamp
    });

  } catch (error) {
    console.error(error);
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
