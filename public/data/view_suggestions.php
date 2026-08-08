<?php
session_start();

// ---------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------
$correctPassword = "colletta";
$suggestionsFile = "suggestions.txt";

// ---------------------------------------------------------
// AUTHENTICATION LOGIC
// ---------------------------------------------------------
$authorized = $_SESSION['authorized'] ?? false;

if (isset($_POST['password'])) {
    if ($_POST['password'] === $correctPassword) {
        $_SESSION['authorized'] = true;
        $authorized = true;
    } else {
        $error = "Incorrect password.";
    }
}

// ---------------------------------------------------------
// CATEGORY NORMALIZATION
// ---------------------------------------------------------
function normalizeCategory($raw) {
    $map = [
        'Category'             => 'Category',
        'Sub-Scene'            => 'Sub-Scene',
        'Scene Element'        => 'Scene Elements',
        'Scene Elements'       => 'Scene Elements',
        'Botanical Foreground' => 'Botanical Foreground',
        'Application Style'    => 'Application Style',
        'Color Mode'           => 'Color Mode'
    ];
    return $map[$raw] ?? 'Uncategorized';
}

// ---------------------------------------------------------
// CATEGORY COLOR HELPER
// ---------------------------------------------------------
function categoryColor($type) {
    $map = [
        'Category'             => '#0077cc',
        'Sub-Scene'            => '#8a2be2',
        'Scene Elements'       => '#d9534f',
        'Botanical Foreground' => '#28a745',
        'Application Style'    => '#ff8c00',
        'Color Mode'           => '#17a2b8',
        'Uncategorized'        => '#6c757d'
    ];
    return $map[$type] ?? '#6c757d';
}

// ---------------------------------------------------------
// HANDLE INLINE EDIT
// ---------------------------------------------------------
if ($authorized && isset($_POST['edit_index'])) {

    $editIndex = (int)$_POST['edit_index'];
    $fieldName = 'new_text_' . $editIndex;
    $newText   = trim($_POST[$fieldName] ?? '');

    if ($newText !== '') {

        $lines = file_exists($suggestionsFile)
            ? file($suggestionsFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES)
            : [];

        if (isset($lines[$editIndex])) {

            $line = $lines[$editIndex];

            // Unbreakable NOWDOC regex
            $patternEdit = <<<'REGEX'
/^

\[(.*?)\]

\s*\((.*?)\)\s*(.*?)\s*\|\s*IP:\s*(.*?)(\s*

\[DONE\]

)?$/
REGEX;

            if (preg_match($patternEdit, $line, $m)) {

                $timestamp = $m[1];
                $typeRaw   = $m[2];
                $type      = normalizeCategory($typeRaw);
                $ip        = $m[4];
                $donePart  = $m[5] ?? '';

                $lines[$editIndex] =
                    "[" . $timestamp . "] (" . $type . ") " .
                    $newText . " | IP: " . $ip . $donePart;

                file_put_contents($suggestionsFile, implode("\n", $lines) . "\n");
                $updated = true;
            }
        }
    }
}

// ---------------------------------------------------------
// HANDLE CHECKBOX UPDATES
// ---------------------------------------------------------
elseif ($authorized && isset($_POST['checked'])) {

    $lines = file_exists($suggestionsFile)
        ? file($suggestionsFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES)
        : [];

    foreach ($_POST['checked'] as $index) {
        $index = (int)$index;
        if (isset($lines[$index]) && strpos($lines[$index], "[DONE]") === false) {
            $lines[$index] .= "   [DONE]";
        }
    }

    file_put_contents($suggestionsFile, implode("\n", $lines) . "\n");
    $updated = true;
}

// ---------------------------------------------------------
// LOAD + PARSE SUGGESTIONS
// ---------------------------------------------------------
$lines = file_exists($suggestionsFile)
    ? file($suggestionsFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES)
    : [];

$parsed = [];

// Unbreakable NOWDOC regex for parsing
$patternParse = <<<'REGEX'
/^

\[(.*?)\]

\s*\((.*?)\)\s*(.*?)\s*\|\s*IP:/
REGEX;

foreach ($lines as $i => $line) {

    $isDone = strpos($line, "[DONE]") !== false;

    if (preg_match($patternParse, $line, $m)) {

        $parsed[] = [
            'index'     => $i,
            'timestamp' => $m[1],
            'type'      => normalizeCategory($m[2]),
            'text'      => $m[3],
            'done'      => $isDone
        ];

    } else {

        $parsed[] = [
            'index'     => $i,
            'timestamp' => '',
            'type'      => 'Uncategorized',
            'text'      => $line,
            'done'      => $isDone
        ];
    }
}

// ---------------------------------------------------------
// SORT NEWEST FIRST
// ---------------------------------------------------------
usort($parsed, function($a, $b) {
    return strtotime($b['timestamp']) <=> strtotime($a['timestamp']);
});



// ---------------------------------------------------------
// FILTER + SEARCH
// ---------------------------------------------------------
$filter = $_GET['filter'] ?? 'All';
$search = $_GET['search'] ?? '';

$types = array_unique(array_column($parsed, 'type'));
sort($types);

?>
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Suggestion Log Viewer</title>
<style>
    body { font-family: Arial, sans-serif; background:#f5f5f5; padding:20px; }
    .container { max-width:900px; margin:auto; background:white; padding:20px; border-radius:8px; }
    .entry { padding:10px 0; border-bottom:1px solid #ddd; }
    .done { color:#888; text-decoration:line-through; }
    .type-badge { padding:2px 6px; border-radius:4px; font-size:12px; margin-right:6px; color:white; display:inline-block; }
    .timestamp { font-size:11px; color:#888; margin-left:24px; }
    .filter-bar a { margin-right:10px; text-decoration:none; color:#0077cc; }
    .filter-bar a:hover { text-decoration:underline; }
    .group-header { cursor:pointer; padding:10px; background:#eee; margin-top:20px; border-radius:6px; font-weight:bold; }
    textarea.inline-edit { width:100%; box-sizing:border-box; }
</style>
<script>
function toggleGroup(id) {
    const el = document.getElementById(id);
    el.style.display = (el.style.display === "none") ? "block" : "none";
}
function startEdit(idx) {
    document.getElementById('view-' + idx).style.display = 'none';
    document.getElementById('edit-' + idx).style.display = 'block';
}
function cancelEdit(idx) {
    document.getElementById('edit-' + idx).style.display = 'none';
    document.getElementById('view-' + idx).style.display = 'block';
}
</script>
</head>
<body>
<div class="container">

<?php if (!$authorized): ?>

    <h2>Enter Pro Unlock Password</h2>
    <?php if (!empty($error)): ?><div style="color:red;"><?= $error ?></div><?php endif; ?>
    <form method="POST">
        <input type="password" name="password" placeholder="Password">
        <input type="submit" value="Unlock">
    </form>

<?php else: ?>

    <h2>Suggestion Log Viewer</h2>
    <?php if (!empty($updated)): ?><div style="color:green;">Updated successfully.</div><?php endif; ?>

    <!-- SEARCH -->
    <form method="GET" style="margin-bottom:15px;">
        <input type="text" name="search" placeholder="Search..." value="<?= htmlspecialchars($search) ?>">
        <input type="submit" value="Search">
    </form>

    <!-- FILTER -->
    <div class="filter-bar" style="margin-bottom:15px;">
        <strong>Filter:</strong>
        <a href="?filter=All">All</a>
        <?php foreach ($types as $t): ?>
            <a href="?filter=<?= urlencode($t) ?>"><?= htmlspecialchars($t) ?></a>
        <?php endforeach; ?>
    </div>

    <form method="POST">
        <?php
// GROUP BY TYPE
$grouped = [];
foreach ($parsed as $item) {
    $grouped[$item['type']][] = $item;
}

foreach ($grouped as $type => $items):

    // Build a list of items that pass BOTH filters
    $visibleItems = [];
    foreach ($items as $item) {
        if ($filter !== 'All' && $item['type'] !== $filter) continue;
        if ($search && stripos($item['text'], $search) === false) continue;
        $visibleItems[] = $item;
    }

    // If no items match, SKIP this group entirely
    if (count($visibleItems) === 0) continue;

    $groupId = "group_" . md5($type);
?>
    <div class="group-header" onclick="toggleGroup('<?= $groupId ?>')">
        <?= htmlspecialchars($type) ?> (<?= count($visibleItems) ?>)
    </div>

    <div id="<?= $groupId ?>" style="display:block;">

    <?php foreach ($visibleItems as $item):
        $css        = $item['done'] ? "done" : "";
        $badgeColor = categoryColor($item['type']);
    ?>
        <div class="entry">
            <input type="checkbox" name="checked[]" value="<?= $item['index'] ?>">
            <strong><?= $item['index'] + 1 ?>.</strong>

            <span class="type-badge" style="background: <?= $badgeColor ?>;">
                <?= htmlspecialchars($item['type']) ?>
            </span>

            <!-- VIEW MODE -->
            <div id="view-<?= $item['index'] ?>">
                <span class="<?= $css ?>" onclick="startEdit(<?= $item['index'] ?>)">
                    <?= htmlspecialchars($item['text']) ?>
                </span>
            </div>

            <!-- EDIT MODE -->
            <div id="edit-<?= $item['index'] ?>" style="display:none;">
                <textarea class="inline-edit" name="new_text_<?= $item['index'] ?>" rows="3"><?= htmlspecialchars($item['text']) ?></textarea>
                <br>
                <button type="submit" name="edit_index" value="<?= $item['index'] ?>">Save</button>
                <button type="button" onclick="cancelEdit(<?= $item['index'] ?>)">Cancel</button>
            </div>

            <div class="timestamp"><?= htmlspecialchars($item['timestamp']) ?></div>
        </div>
    <?php endforeach; ?>

    </div>
<?php endforeach; ?>


        <br>
        <input type="submit" value="Mark Selected as Done">
    </form>

    <form method="POST">
        <input type="hidden" name="logout" value="1">
        <input type="submit" value="Log Out">
    </form>

<?php endif; ?>

</div>
</body>
</html>
