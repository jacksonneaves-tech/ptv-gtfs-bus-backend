import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// 🔐 Put your exact working key here
const API_KEY = "1a9699bf-54d2-42a4-a170-5416f7f6993a";

const GTFS_URL =
  "https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/bus/vehicle-positions";

app.get("/", (req, res) => {
  res.send("Key Debug Running");
});

app.get("/debug", async (req, res) => {
  try {
    const response = await fetch(GTFS_URL, {
      headers: {
        KeyId: API_KEY.trim()
      }
    });

    res.json({
      status: response.status,
      keyLength: API_KEY.length,
      first4: API_KEY.substring(0,4),
      last4: API_KEY.substring(API_KEY.length-4),
      contentType: response.headers.get("content-type")
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log("Server running");
});
