// redeploy-sd3.5-multipart

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import cors from "cors";
import FormData from "form-data";

dotenv.config();

const app = express();

// 🔒 Force CORS headers on ALL responses (including 502 errors from Render)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://gohw.net");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

// 🔧 Clean preflight handling
app.options("*", (req, res) => {
  res.sendStatus(204);
});

// ⭐ Existing CORS middleware (kept exactly as you had it)
app.use(cors({
  origin: ["https://gohw.net", "https://localhost"]
}));

app.use(express.json());

app.post("/generate", async (req, res) => {
  try {
    const {
      prompt,
      negative_prompt,
      aspect_ratio,
      seed,
      model
    } = req.body;

    console.log("Incoming prompt:", prompt);
    console.log("Incoming negative prompt:", negative_prompt);
    console.log("Incoming aspect ratio:", aspect_ratio);
    console.log("Incoming seed:", seed);

    const selectedModel = model || "sd3.5-large";
    console.log("🖼️ Using Stability model:", selectedModel);

    const form = new FormData();

    form.append("prompt", prompt);
    form.append("model", selectedModel);
    form.append("output_format", "png");

    if (negative_prompt && negative_prompt.trim() !== "") {
      form.append("negative_prompt", negative_prompt);
    }

    if (aspect_ratio) {
      form.append("aspect_ratio", aspect_ratio);
    }

    if (seed !== undefined) {
      form.append("seed", seed);
    }

    form.append("none", "");

    const response = await fetch(
      "https://api.stability.ai/v2beta/stable-image/generate/sd3",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.STABILITY_API_KEY}`,
          "Accept": "image/*"
        },
        body: form
      }
    );

    console.log("Stability raw response status:", response.status);

    if (response.status === 200) {
      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString("base64");

      return res.json({
        success: true,
        image: base64
      });
    }

    const errorJson = await response.json();
    console.log("Stability error JSON:", errorJson);

    return res.status(500).json({
      success: false,
      error: errorJson
    });

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Generation failed" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
