// redeploy-sd3.5

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();

// ⭐ Enable CORS so your frontend at gohw.net can call this backend
app.use(cors({
  origin: ["https://gohw.net", "https://localhost"]
}));

app.use(express.json());
app.use(express.static(".")); // harmless, fine to keep

app.post("/generate", async (req, res) => {
  try {
    const {
      prompt,
      negative_prompt,
      width,
      height,
      aspect_ratio,
      seed
    } = req.body;

    console.log("Incoming prompt:", prompt);
    console.log("Incoming aspect ratio:", aspect_ratio);
    console.log("Incoming seed:", seed);

    // ⭐ Build JSON payload for SD3.5
    const payload = {
      const payload = {
  prompt,
  output_format: "png"
};

if (negative_prompt) {
  payload.negative_prompt = negative_prompt;
}


    // ⭐ Use aspect_ratio OR width/height — not both
    if (aspect_ratio) {
      payload.aspect_ratio = aspect_ratio;
    } else {
      payload.width = width;
      payload.height = height;
    }

    if (seed !== undefined) {
      payload.seed = seed;
    }

    const response = await fetch(
      "https://api.stability.ai/v2beta/stable-image/generate/sd3.5-large-turbo",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.STABILITY_API_KEY}`,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    console.log("Stability raw response status:", response.status);

    const result = await response.json();
    console.log("Stability JSON:", result);

    res.json(result);

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Generation failed" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
