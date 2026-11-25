package com.tradera.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

/** Where this phone checks for ringing alerts, saved when it is paired from Alerts. */
final class AlarmPrefs {
    private static final String FILE = "tradera_alarm";

    private AlarmPrefs() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    static boolean paired(Context c) {
        SharedPreferences p = prefs(c);
        return p.getString("base", null) != null && p.getString("d", null) != null && p.getString("k", null) != null;
    }

    static void save(Context c, String base, String u, String d, String k) {
        prefs(c).edit().putString("base", base).putString("u", u == null ? "" : u)
                .putString("d", d).putString("k", k).apply();
    }

    static void clear(Context c) {
        prefs(c).edit().clear().apply();
    }

    static String base(Context c) {
        return prefs(c).getString("base", "");
    }

    static String user(Context c) {
        return prefs(c).getString("u", "");
    }

    static String pollUrl(Context c) {
        SharedPreferences p = prefs(c);
        Uri.Builder b = Uri.parse(p.getString("base", "") + "/api/alarm/poll").buildUpon()
                .appendQueryParameter("d", p.getString("d", ""))
                .appendQueryParameter("k", p.getString("k", ""));
        String u = p.getString("u", "");
        if (u != null && !u.isEmpty()) b.appendQueryParameter("u", u);
        return b.build().toString();
    }

    /** Only https sites (or a local test server) may be paired. */
    static boolean allowedBase(String base) {
        if (base == null) return false;
        Uri u = Uri.parse(base);
        String host = u.getHost();
        if (host == null) return false;
        if ("https".equals(u.getScheme())) return true;
        return "http".equals(u.getScheme()) && ("localhost".equals(host) || "127.0.0.1".equals(host) || "10.0.2.2".equals(host));
    }
}
