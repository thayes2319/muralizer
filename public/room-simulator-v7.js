// ============================================================
// ROOM SIMULATOR DATA MODEL
// ============================================================

let walls = [
  {
    wallNumber: 1,
    lengthInches: 0,
    wallHeight: 0,
    trimHeight: 0,
    features: []
  }
];

// ============================================================
// FEATURE INSTRUCTIONS TEMPLATE
// ============================================================

const FEATURE_INSTRUCTIONS_HTML = `
  <div class="feature-instructions">
    <div><strong>Type:</strong> Select the feature type (Doorway, Window, Opening, Other).</div>
    <div><strong>Feature Start:</strong> Measure from last: last corner or end of previous feature.</div>
    <div><strong>Width & Height:</strong> Enter the actual feature size (outside trim-to-trim).</div>
    <div><strong>Vertical Start:</strong> Measure from the base trim, or from chair rail if present.</div>
  </div>
`;

// ============================================================
// FEATURE INSTRUCTIONS VISIBILITY CONTROLLER
// ============================================================
// Show instructions inside the wall where the FIRST feature exists.

function updateFeatureInstructionsVisibility() {
  // Count total features across all walls
  const totalFeatures = walls.reduce((sum, w) => sum + w.features.length, 0);

  // Clear ALL instruction containers
  walls.forEach((_, i) => {
    const c = document.getElementById(`feature-instructions-container-${i}`);
    if (c) c.innerHTML = "";
  });

  // If no features exist → nothing to show
  if (totalFeatures === 0) return;

  // Find the FIRST wall that has a feature
  const firstWallIndex = walls.findIndex(w => w.features.length > 0);

  // Inject instructions into THAT wall
  const container = document.getElementById(`feature-instructions-container-${firstWallIndex}`);
  if (container) container.innerHTML = FEATURE_INSTRUCTIONS_HTML;
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  renderAllWalls();
  updateSummary();
});

// ============================================================
// WALL UPDATE FUNCTIONS
// ============================================================

function updateWallLength(wallIndex, value) {
  walls[wallIndex].lengthInches = Number(value) || 0;
  updateSummary();
}

function updateWallHeight(wallIndex, value) {
  walls[wallIndex].wallHeight = Number(value) || 0;
  updateSummary();
}

function updateWallTrimHeight(wallIndex, value) {
  walls[wallIndex].trimHeight = Number(value) || 0;
  updateSummary();
}

// ============================================================
// WALL MANAGEMENT
// ============================================================

function addWall() {
  const next = walls.length + 1;
  const lastWall = walls[walls.length - 1];

  walls.push({
    wallNumber: next,
    lengthInches: 0,
    wallHeight: lastWall.wallHeight,
    trimHeight: lastWall.trimHeight,
    features: []
  });

  renderAllWalls();
  updateSummary();
}

function deleteWall(wallIndex) {
  if (walls.length === 1) {
    alert("You must have at least one wall. The last wall cannot be deleted.");
    return;
  }

  if (!confirm("Delete this wall?")) return;

  walls.splice(wallIndex, 1);

  walls.forEach((w, i) => w.wallNumber = i + 1);

  renderAllWalls();
  updateSummary();
}

// ============================================================
// FEATURE MANAGEMENT
// ============================================================

function addFeatureToWall(wallIndex) {
  const wall = walls[wallIndex];
  const next = wall.features.length + 1;

  wall.features.push({
    featureNumber: next,
    type: "",
    start: 0,
    width: 0,
    height: 0,
    verticalStart: 0
  });

  renderFeaturesForWall(wallIndex);
  updateFeatureInstructionsVisibility();
}

function deleteFeature(wallIndex, featureIndex) {
  if (!confirm("Delete this feature?")) return;

  const wall = walls[wallIndex];
  wall.features.splice(featureIndex, 1);

  wall.features.forEach((f, i) => f.featureNumber = i + 1);

  renderFeaturesForWall(wallIndex);
  updateFeatureInstructionsVisibility();
}

function copyLastFeature(wallIndex) {
  const wall = walls[wallIndex];
  if (wall.features.length === 0) return;

  const last = wall.features[wall.features.length - 1];

  const newFeature = {
    featureNumber: wall.features.length + 1,
    type: last.type,
    start: last.start,
    width: last.width,
    height: last.height,
    verticalStart: last.verticalStart
  };

  wall.features.push(newFeature);
  renderFeaturesForWall(wallIndex);
  updateFeatureInstructionsVisibility();
}

function updateFeature(wallIndex, featureIndex, field, value) {
  const f = walls[wallIndex].features[featureIndex];
  f[field] = field === "type" ? value : Number(value) || 0;

  // Do NOT re-render here — it kills input focus on iOS
  updateFeatureInstructionsVisibility();
}


// ============================================================
// FEATURE FIT VALIDATION
// ============================================================

function checkFeaturesFitOnWall(wall) {
  const wallLen = wall.lengthInches || 0;
  const sorted = [...wall.features].sort((a, b) => a.start - b.start);

  let lastEnd = 0;
  for (const f of sorted) {
    lastEnd = Math.max(lastEnd, f.start + f.width);
  }

  const featureToWallEnd = wallLen - lastEnd;
  const fits = featureToWallEnd >= 0;

  return { featureToWallEnd, fits };
}

// ============================================================
// RENDERING
// ============================================================

function renderAllWalls() {
  const container = document.getElementById("walls-container");
  container.innerHTML = "";

  walls.forEach((wall, index) => {
    const block = document.createElement("div");
    block.className = "wall-block";

    block.innerHTML = `
      <div class="wall-header">
        <h3>Wall ${wall.wallNumber}</h3>
        <button class="delete-wall-btn" onclick="deleteWall(${index})">Delete Wall</button>
      </div>

      <div class="wall-fields">
        <label>
          Length:
          <input type="number" min="0" value="${wall.lengthInches}"
            oninput="updateWallLength(${index}, this.value)">
        </label>

        <label>
          Wall Height:
          <input type="number" min="0" value="${wall.wallHeight}"
            oninput="updateWallHeight(${index}, this.value)">
        </label>

        <label>
          Trim-to-Trim Height:
          <input type="number" min="0" value="${wall.trimHeight}"
            oninput="updateWallTrimHeight(${index}, this.value)">
        </label>
      </div>

      <div class="feature-instructions-container" id="feature-instructions-container-${index}"></div>

      <div class="feature-list" id="feature-list-${index}"></div>

      <button class="add-feature-btn" onclick="addFeatureToWall(${index})">
        + Add Feature
      </button>

      <button id="copy-btn-${index}" class="add-feature-btn"
        onclick="copyLastFeature(${index})"
        style="${wall.features.length === 0 ? "display:none" : "display:inline-block"}">
        Copy Last Feature
      </button>
    `;

    container.appendChild(block);
    renderFeaturesForWall(index);
  });

  updateFeatureInstructionsVisibility();
}

function renderFeaturesForWall(wallIndex) {
  const wall = walls[wallIndex];
  const list = document.getElementById(`feature-list-${wallIndex}`);

  list.innerHTML = "";

  wall.features.forEach((f, featureIndex) => {
    const row = document.createElement("div");
    row.className = "feature-row";

    row.innerHTML = `
      <label>
        Type:
        <select onchange="updateFeature(${wallIndex}, ${featureIndex}, 'type', this.value)">
          <option value="">Type</option>
          <option ${f.type === "Doorway" ? "selected" : ""}>Doorway</option>
          <option ${f.type === "Window" ? "selected" : ""}>Window</option>
          <option ${f.type === "Base Cab" ? "selected" : ""}>Base Cab</option>
          <option ${f.type === "Wall Cab" ? "selected" : ""}>Wall Cab</option>
          <option ${f.type === "Fireplace" ? "selected" : ""}>Fireplace</option>
          <option ${f.type === "TV Box" ? "selected" : ""}>TV Box</option>
          <option ${f.type === "Other" ? "selected" : ""}>Other</option>
        </select>
      </label>

      <label>
        Start:
        <input type="number" min="0" value="${f.start}"
          oninput="updateFeature(${wallIndex}, ${featureIndex}, 'start', this.value)">
      </label>

      <label>
        Width:
        <input type="number" min="0" value="${f.width}"
          oninput="updateFeature(${wallIndex}, ${featureIndex}, 'width', this.value)">
      </label>

      <label>
        Height:
        <input type="number" min="0" value="${f.height}"
          oninput="updateFeature(${wallIndex}, ${featureIndex}, 'height', this.value)">
      </label>

      <label>
        Vert. Start:
        <input type="number" min="0" value="${f.verticalStart}"
          oninput="updateFeature(${wallIndex}, ${featureIndex}, 'verticalStart', this.value)">
      </label>

      <button class="delete-feature-btn"
        onclick="deleteFeature(${wallIndex}, ${featureIndex})">
        ✕
      </button>
    `;

    list.appendChild(row);
  });

  if (wall.features.length > 0) {
    const { featureToWallEnd, fits } = checkFeaturesFitOnWall(wall);

    const validation = document.createElement("div");
    validation.style.marginTop = "8px";
    validation.style.fontSize = "0.9rem";

    validation.innerHTML = `
      <strong>Feature to Wall End:</strong> ${featureToWallEnd} in<br>
      <strong>Fits:</strong> ${fits ? "✓ Yes" : "✗ No"}
    `;

    list.appendChild(validation);
  }

  const copyBtn = document.getElementById(`copy-btn-${wallIndex}`);
  if (copyBtn) {
    copyBtn.style.display = wall.features.length > 0 ? "inline-block" : "none";
  }
}

// ============================================================
// SUMMARY
// ============================================================

function updateSummary() {
  const wallCount = walls.length;
  const perimeter = walls.reduce((sum, w) => sum + (w.lengthInches || 0), 0);

  document.getElementById("summary-wall-count").textContent = wallCount;
  document.getElementById("summary-perimeter").textContent = `${perimeter} in`;
}

// ============================================================
// AUTO SELECT IN DATA FIELDS
// ============================================================

document.addEventListener("focusin", function (e) {
  if (e.target.tagName === "INPUT") {
    e.target.select();
  }
});


// -----------------------------
// INSTRUCTION IMAGE ZOOM Modal Elements
// -----------------------------
const modal = document.getElementById("image-modal");
const zoomContainer = document.getElementById("zoom-container");
const modalImg = document.getElementById("modal-img");

// -----------------------------
// State
// -----------------------------
let scale = 1;
let lastScale = 1;
let startDistance = 0;

let panX = 0;
let panY = 0;
let lastPanX = 0;
let lastPanY = 0;

let lastTouchX = 0;
let lastTouchY = 0;

// -----------------------------
// Open modal on tap
// -----------------------------
document.getElementById("instruction-img").addEventListener("click", () => {
  openImageModal();
});

function openImageModal() {
  modal.style.display = "flex";
  resetZoom();
}

// -----------------------------
// Close modal on tap
// -----------------------------
modal.addEventListener("click", () => {
  modal.style.display = "none";
});

// Prevent closing when dragging inside
zoomContainer.addEventListener("click", (e) => {
  e.stopPropagation();
});

// -----------------------------
// Reset zoom + pan
// -----------------------------
function resetZoom() {
  scale = 1;
  lastScale = 1;
  panX = 0;
  panY = 0;
  lastPanX = 0;
  lastPanY = 0;
  applyTransform();
}

// -----------------------------
// Apply transform
// -----------------------------
function applyTransform() {
  zoomContainer.style.transform =
    `translate(${panX}px, ${panY}px) scale(${scale})`;
}

// -----------------------------
// Touch handling
// -----------------------------
zoomContainer.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2) {
    // Pinch start
    startDistance = getDistance(e.touches[0], e.touches[1]);
    lastScale = scale;
  } else if (e.touches.length === 1) {
    // Pan start
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
    lastPanX = panX;
    lastPanY = panY;
  }
});

zoomContainer.addEventListener("touchmove", (e) => {
  e.preventDefault();

  if (e.touches.length === 2) {
    // Pinch zoom
    const newDistance = getDistance(e.touches[0], e.touches[1]);
    scale = Math.max(1, Math.min(5, lastScale * (newDistance / startDistance)));
    applyTransform();
  } else if (e.touches.length === 1 && scale > 1) {
    // Pan
    const dx = e.touches[0].clientX - lastTouchX;
    const dy = e.touches[0].clientY - lastTouchY;

    panX = lastPanX + dx;
    panY = lastPanY + dy;

    applyTransform();
  }
});

// -----------------------------
// Utility: distance between two touches
// -----------------------------
function getDistance(t1, t2) {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}



// ============================================================
// EXPORT
// ============================================================

function getRoomData() {
  return {
    walls: JSON.parse(JSON.stringify(walls)),
    perimeterInches: walls.reduce((sum, w) => sum + (w.lengthInches || 0), 0)
  };
}

function getRoomData() {
  return {
    walls: JSON.parse(JSON.stringify(walls)),
    perimeterInches: walls.reduce((sum, w) => sum + (w.lengthInches || 0), 0)
  };
}


/* ============================================================
   SUBMIT / EXPORT
   ============================================================ */

function submitRoomData() {
  const data = getRoomData();

  let csv = "Wall,Feature,Type,Start,Width,Height,Vertical Start,Wall Length,Wall Height,Trim Height\n";

  data.walls.forEach(wall => {
    if (wall.features.length === 0) {
      csv += `${wall.wallNumber},,, , , , ,${wall.lengthInches},${wall.wallHeight},${wall.trimHeight}\n`;
    } else {
      wall.features.forEach(f => {
        csv += [
          wall.wallNumber,
          f.featureNumber,
          f.type,
          f.start,
          f.width,
          f.height,
          f.verticalStart,
          wall.lengthInches,
          wall.wallHeight,
          wall.trimHeight
        ].join(",") + "\n";
      });
    }
  });

  alert("Copy this data:\n\n" + csv);
}

