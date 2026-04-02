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
      seed
    } = req.body;

    console.log("Incoming prompt:", prompt);
    console.log("Incoming aspect ratio:", aspect_ratio);
    console.log("Incoming seed:", seed);

    // ⭐ Build multipart/form-data payload for SD3.5
    const form = new FormData();

    // ⭐ Required fields
    form.append("prompt", prompt);
    
    // ⭐ Allow frontend to choose the model, default to sd3.5-large
form.append("model", req.body.model || "sd3.5-large");

    form.append("output_format", "png");     // png, jpeg, webp

    // ⭐ Only include negative_prompt if valid
    if (negative_prompt && negative_prompt.trim() !== "") {
      form.append("negative_prompt", negative_prompt);
    }

    // ⭐ Aspect ratio (only valid for text-to-image)
    if (aspect_ratio) {
      form.append("aspect_ratio", aspect_ratio);
    }

    // ⭐ Seed (0 = random)
    if (seed !== undefined) {
      form.append("seed", seed);
    }

    // ⭐ Stability requires a dummy file field for multipart/form-data
    form.append("none", "");

    // ⭐ Call the official SD3.5 endpoint (multipart/form-data)
    const response = await fetch(
      // NEW — honors selector, defaults to sd3.5-large
      `https://api.stability.ai/v2beta/stable-image/generate/${req.body.model || "sd3.5"}`
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.STABILITY_API_KEY}`,
          "Accept": "image/*"   // ⭐ Required: tells Stability to return raw image bytes
        },
        body: form
      }
    );


    const response = await fetch(
  `https://api.stability.ai/v2beta/stable-image/generate/${req.body.model || "sd3.5-large"}`,
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

    // ⭐ If successful, Stability returns raw image bytes (NOT JSON)
    if (response.status === 200) {
      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString("base64");

      return res.json({
        success: true,
        image: base64
      });
    }

    // ⭐ If error, Stability returns JSON
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
