<?php
// Allow your app (WebView) to POST to this script
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST");
header("Access-Control-Allow-Headers: Content-Type");

// Pull POST data safely
$type = $_POST['type'] ?? 'Unknown';
$suggestion = $_POST['suggestion'] ?? '';
$ip = $_SERVER['REMOTE_ADDR'] ?? '';
$time = date('Y-m-d H:i:s');

// Only run logic if a suggestion was actually submitted
if ($suggestion) {

  // Build the newest log entry (single line for SMS safety)
  $line = "[$time] ($type) $suggestion | IP: $ip\n";

  // Append newest entry to suggestions.txt
  file_put_contents('suggestions.txt', $line, FILE_APPEND);

  // Load full history for email
  $fullHistory = file_get_contents('suggestions.txt');

  // AT&T‑compliant headers (these matter!)
  $headers  = "From: noreply@gohw.net\r\n";
  $headers .= "Reply-To: noreply@gohw.net\r\n";
  $headers .= "Return-Path: noreply@gohw.net\r\n";
  $headers .= "Content-Type: text/plain; charset=UTF-8\r\n";

  // SMS: send ONLY the newest suggestion
  // AT&T MMS gateway is the most reliable
  $smsBody = $line;
  mail("7705089596@mms.att.net", "New Suggestion", $smsBody, $headers);

  // Email: send full log to your inbox
  mail("thomas@gohw.net", "Full Muralizer Suggestion Log", $fullHistory, $headers);
}

// Always return OK so the app knows the request completed
echo "OK";
?>
