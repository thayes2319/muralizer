import cors from "cors";

app.use(cors({
  origin: "https://gohw.net"
}));


import express from "express";
import fetch from "node-fetch";
import FormData from "form-data";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static(".")); // serve your muralmaker.html and assets

app.post("/generate", async (req, res) => {
  try {
    // ⭐ Read aspect_ratio from the request body
    const { prompt, width, height, aspect_ratio } = req.body;

    console.log("Incoming prompt:", prompt);
    console.log("Incoming aspect ratio:", aspect_ratio);

    // Build multipart/form-data request
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("output_format", "png");

    // ⭐ Use aspect_ratio OR width/height — not both
    if (aspect_ratio) {
      form.append("aspect_ratio", aspect_ratio);
    } else {
      form.append("width", width);
      form.append("height", height);
    }

    const response = await fetch(
      "https://api.stability.ai/v2beta/stable-image/generate/sd3",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.STABILITY_API_KEY}`,
          "Accept": "application/json"
        },
        body: form
      }
    );

    console.log("Stability raw response status:", response.status);

    const result = await response.json();
    console.log("Stability JSON:", result);

    // Return the JSON directly to the front-end
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




