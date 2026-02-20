import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJqdGkiOiIzUmQ1c25ydFR1QldLcTg5eExyWjVYQk5ubnZuMk8wTm1KT0JrR1N1aE5vIiwiaWF0IjoxNzcxNTg0MTk2fQ.QXIUE8-VEdS0azZSJpBtYB0zxl9B68lPJHS1d4XID6s";

const GTFS_URL =
  "https://api.opendata.transport.vic.gov.au/opendata/public-transport/gtfs/realtime/v1/bus/vehicle-positions";

app.get("/", (req, res) => {
  res.send("Debug Server Running");
});

app.get("/debug", async (req, res) => {
  try {
    const response = await fetch(GTFS_URL, {
      headers: {
        "KeyId": API_KEY
      }
    });

    const status = response.status;
    const contentType = response.headers.get("content-type");

    let preview;
    try {
      preview = await response.text();
      preview = preview.substring(0, 500);
    } catch (e) {
      preview = "Could not read body";
    }

    res.json({
      status,
      contentType,
      bodyPreview: preview
    });

  } catch (error) {
    res.status(500).json({
      error: "fetch_failed",
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
