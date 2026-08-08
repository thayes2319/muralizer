package com.gohw.muralizer;

import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
//import com.gohw.muralizer.MediaStorePlugin;   // ⭐ DELETE THIS LINE COMPLETELY

public class MainActivity extends BridgeActivity {
    private static final String TAG = "MainActivity";

    @Override
    protected void onCreate(Bundle savedInstanceState) {

        // ⭐ CRITICAL: Register plugin BEFORE calling super.onCreate()
        //registerPlugin(MediaStorePlugin.class);   // ⭐ DELETE THIS LINE COMPLETELY

        // ⭐ Enable WebView debugging so Chrome DevTools can see the app
        WebView.setWebContentsDebuggingEnabled(true);

        // ⭐ Initialize Capacitor bridge AFTER plugin registration
        super.onCreate(savedInstanceState);

        // ⭐ CONFIRMATION LOG — this tells us the correct build is running
        Log.i("MainActivity", "🔥 NEW MAINACTIVITY BUILD IS RUNNING");

        try {
    Object bridgeWebView = this.getBridge().getWebView();

    if (bridgeWebView instanceof WebView) {
        WebView webView = (WebView) bridgeWebView;

        // ⭐ Block long‑press Save‑As menu (safe)
        webView.setOnLongClickListener(v -> true);
        webView.setLongClickable(false);

        // ❌ DO NOT block drag or gesture events — needed for scroll + pinch‑zoom
        // webView.setHapticFeedbackEnabled(false);
        // webView.setOnDragListener((v, event) -> true);

        Log.i(TAG, "WebView long‑press disabled (Save‑As blocked)");
    } else {
        Log.w(TAG, "Bridge WebView is not an android.webkit.WebView. Type: "
                + (bridgeWebView != null ? bridgeWebView.getClass().getName() : "null"));
    }
} catch (Exception e) {
    Log.e(TAG, "Failed to configure WebView", e);
}

    }
}
