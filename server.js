// redeploy-sd3.5-multipart

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import cors from "cors";
import FormData from "form-data";

dotenv.config();

const app = express();

// ⭐ Enable CORS so your frontend at gohw.net can call this backend
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
    console.log("Incoming aspect ratio:", aspect_ratio);
    console.log("Incoming seed:", seed);

    // ⭐ Determine model (default: sd3.5-large)
    const selectedModel = model || "sd3.5-large";
    console.log("🖼️ Using Stability model:", selectedModel);

    // ⭐ Build multipart/form-data payload for SD3.5
    const form = new FormData();

    form.append("prompt", prompt);
    form.append("model", selectedModel);   // <-- Correct place for model
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

    // Required dummy field
    form.append("none", "");

    // ⭐ Correct SD3.5 endpoint (fixed)
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

    // Error case
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
