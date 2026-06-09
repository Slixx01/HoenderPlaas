from flask import Flask, send_from_directory, request, jsonify
import pandas as pd
import numpy as np
import os
from io import BytesIO
import traceback

app = Flask(__name__, static_folder='public', static_url_path='/')

data_store = {
    "daily_weight": None,
    "daily_morts":  None,
    "filename":     None
}

# ── Excel Parsing ──────────────────────────────────────────────────────────

def parse_excel(file_stream):
    xl = pd.ExcelFile(file_stream, engine='openpyxl')
    sheets = xl.sheet_names
    if len(sheets) < 4:
        raise ValueError(f"Need ≥4 sheets, found {len(sheets)}: {sheets}")
    weight_df = parse_daily_sheet(file_stream, sheets[2], "weight",  col_offset=2)
    morts_df  = parse_daily_sheet(file_stream, sheets[3], "morts",   col_offset=2)
    return weight_df, morts_df


def parse_daily_sheet(file_stream, sheet_name, data_type, col_offset=2):
    """
    Parse a daily data sheet.
    - Row 2: day-number headers starting at col_offset
    - Each flock block: flock number in col 0, house label in col 1 (H1..H10 or '3 C Avg')
    - The cumulative section (cols 40+) is ignored; we only read cols 2-37.
    Returns DataFrame: flock, house, day, value
    """
    df = pd.read_excel(file_stream, sheet_name=sheet_name, header=None, engine='openpyxl')

    # Build day index from row 2, cols 2..37
    days = []
    for val in df.iloc[2, col_offset:38]:
        try:
            days.append(int(float(val)))
        except (ValueError, TypeError):
            days.append(None)

    records = []
    current_flock = None

    for i, row in df.iterrows():
        flock_val = row[0]
        house_val = row[1]

        # Update current flock when col 0 has a numeric value
        if pd.notna(flock_val):
            try:
                current_flock = int(float(flock_val))
            except (ValueError, TypeError):
                pass

        if pd.isna(house_val) or current_flock is None:
            continue

        house_str = str(house_val).strip()
        if house_str == '3 C Avg':
            house_str = '3C_AVG'
        elif not (house_str.startswith('H') and house_str[1:].isdigit()):
            continue  # skip average/total rows

        for col_i, day in enumerate(days):
            if day is None:
                continue
            col_idx = col_offset + col_i
            if col_idx >= df.shape[1]:
                continue
            val = row[col_idx]
            if pd.isna(val):
                continue
            try:
                records.append({
                    "flock": current_flock,
                    "house": house_str,
                    "day":   day,
                    "value": float(val)
                })
            except (ValueError, TypeError):
                pass

    return pd.DataFrame(records)


# ── Query Helpers ──────────────────────────────────────────────────────────

def current_flock_id(df):
    return int(max(df[df["house"] != "3C_AVG"]["flock"].unique()))


def get_available_days(flock=None):
    df = data_store["daily_weight"]
    if df is None:
        return []
    if flock is None:
        flock = current_flock_id(df)
    days = sorted(df[(df["flock"] == flock) & (df["house"] != "3C_AVG")]["day"].unique())
    return [int(d) for d in days]


def get_all_flocks_summary():
    df = data_store["daily_weight"]
    if df is None:
        return []
    flocks = sorted(df[df["house"] != "3C_AVG"]["flock"].unique())
    out = []
    for f in flocks:
        sub = df[(df["flock"] == f) & (df["house"] != "3C_AVG")]
        out.append({"flock": int(f), "max_day": int(sub["day"].max()) if not sub.empty else 0})
    return out


def three_cycle_avg_weight(day):
    """Return the 3-cycle average weight for a given day (scalar)."""
    df = data_store["daily_weight"]
    avg_rows = df[(df["house"] == "3C_AVG") & (df["day"] == day)]
    if not avg_rows.empty:
        return float(avg_rows.iloc[0]["value"])
    # Fall back: calculate from previous 3 flocks
    flock = current_flock_id(df)
    all_flocks = sorted(df[df["house"] != "3C_AVG"]["flock"].unique())
    prev = [f for f in all_flocks if f != flock][-3:]
    sub = df[(df["flock"].isin(prev)) & (df["day"] == day) & (df["house"] != "3C_AVG")]
    return float(sub["value"].mean()) if not sub.empty else None


def three_cycle_avg_morts(day):
    """Return the 3-cycle average daily morts for a given day (scalar)."""
    df = data_store["daily_morts"]
    avg_rows = df[(df["house"] == "3C_AVG") & (df["day"] == day)]
    if not avg_rows.empty:
        return float(avg_rows.iloc[0]["value"])
    flock = current_flock_id(df)
    all_flocks = sorted(df[df["house"] != "3C_AVG"]["flock"].unique())
    prev = [f for f in all_flocks if f != flock][-3:]
    sub = df[(df["flock"].isin(prev)) & (df["day"] == day) & (df["house"] != "3C_AVG")]
    return float(sub["value"].mean()) if not sub.empty else None


# ── Route: upload ──────────────────────────────────────────────────────────

@app.route("/")
@app.route("/index.html")
def index():
    return send_from_directory(app.static_folder, 'index.html')


@app.route("/<path:filename>")
def serve_static(filename):
    return send_from_directory(app.static_folder, filename)


@app.route("/upload", methods=["POST"])
def upload():
    try:
        if "file" not in request.files:
            return jsonify({"error": "No file uploaded"}), 400
        file = request.files["file"]
        if not file.filename.lower().endswith((".xlsx", ".xls")):
            return jsonify({"error": "Please upload an .xlsx or .xls file"}), 400

        stream = BytesIO(file.read())
        weight_df, morts_df = parse_excel(stream)

        if weight_df.empty:
            return jsonify({"error": "No weight data found in workbook"}), 400

        data_store["daily_weight"] = weight_df
        data_store["daily_morts"]  = morts_df
        data_store["filename"]     = file.filename

        return jsonify({
            "success":        True,
            "filename":       file.filename,
            "flocks":         get_all_flocks_summary(),
            "available_days": get_available_days(),
            "weight_records": len(weight_df),
            "morts_records":  len(morts_df) if morts_df is not None else 0
        })
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500


# ── Route: weight report for a day ─────────────────────────────────────────

@app.route("/api/weight_day")
def api_weight_day():
    day       = request.args.get("day", type=int)
    threshold = request.args.get("threshold", default=5.0, type=float)
    if day is None:
        return jsonify({"error": "day required"}), 400

    wdf = data_store["daily_weight"]
    mdf = data_store["daily_morts"]
    if wdf is None:
        return jsonify({"error": "No data loaded"}), 400

    flock    = current_flock_id(wdf)
    avg_val  = three_cycle_avg_weight(day)

    current  = wdf[(wdf["flock"] == flock) & (wdf["day"] == day) & (wdf["house"] != "3C_AVG")]
    cur_morts = mdf[(mdf["flock"] == flock) & (mdf["day"] == day) & (mdf["house"] != "3C_AVG")] if mdf is not None else None

    houses = []
    for _, row in current.iterrows():
        h   = row["house"]
        val = row["value"]
        pct = ((val - avg_val) / avg_val * 100) if avg_val else None
        if pct is None:          status = "ok"
        elif pct < -threshold:   status = "below"
        elif pct > threshold:    status = "above"
        else:                    status = "ok"

        mort = None
        if cur_morts is not None:
            mr = cur_morts[cur_morts["house"] == h]
            if not mr.empty:
                mort = round(float(mr.iloc[0]["value"]), 0)

        houses.append({
            "house":      h,
            "weight":     round(val, 1),
            "avg_weight": round(avg_val, 1) if avg_val else None,
            "pct_diff":   round(pct, 2) if pct is not None else None,
            "status":     status,
            "morts":      mort
        })

    houses.sort(key=lambda x: x["house"])
    return jsonify({
        "flock":           flock,
        "day":             day,
        "three_cycle_avg": round(avg_val, 1) if avg_val else None,
        "houses":          houses,
        "below_avg_count": sum(1 for h in houses if h["status"] == "below"),
        "above_avg_count": sum(1 for h in houses if h["status"] == "above"),
    })


# ── Route: mortality report for a day ─────────────────────────────────────

@app.route("/api/mortality_day")
def api_mortality_day():
    day = request.args.get("day", type=int)
    if day is None:
        return jsonify({"error": "day required"}), 400

    mdf = data_store["daily_morts"]
    if mdf is None:
        return jsonify({"error": "No mortality data loaded"}), 400

    flock   = current_flock_id(mdf)
    avg_val = three_cycle_avg_morts(day)

    current = mdf[(mdf["flock"] == flock) & (mdf["day"] == day) & (mdf["house"] != "3C_AVG")]

    houses = []
    total  = 0
    for _, row in current.iterrows():
        h    = row["house"]
        mort = row["value"]
        total += mort
        pct  = ((mort - avg_val) / avg_val * 100) if avg_val else None
        houses.append({
            "house":    h,
            "morts":    int(mort),
            "avg_morts": round(avg_val, 1) if avg_val else None,
            "pct_diff": round(pct, 2) if pct is not None else None,
            "status":   "high" if (pct and pct > 20) else "ok"
        })

    houses.sort(key=lambda x: x["house"])
    return jsonify({
        "flock":       flock,
        "day":         day,
        "houses":      houses,
        "total_morts": int(total),
        "avg_morts":   round(avg_val, 1) if avg_val else None,
        "house_count": len(houses)
    })


# ── Route: mortality weekly breakdown ─────────────────────────────────────

@app.route("/api/mortality_weekly")
def api_mortality_weekly():
    mdf = data_store["daily_morts"]
    if mdf is None:
        return jsonify({"error": "No mortality data loaded"}), 400

    flock      = current_flock_id(mdf)
    flock_data = mdf[(mdf["flock"] == flock) & (mdf["house"] != "3C_AVG")]
    max_day    = int(flock_data["day"].max()) if not flock_data.empty else 0
    num_weeks  = max((max_day // 7) + 1, 1)

    houses_out = []
    for house in sorted(flock_data["house"].unique()):
        hd    = flock_data[flock_data["house"] == house]
        weeks = [0.0] * num_weeks
        total = 0.0
        for _, row in hd.iterrows():
            d = int(row["day"])
            v = row["value"]
            w = d // 7
            if w < num_weeks:
                weeks[w] += v
            total += v
        houses_out.append({
            "name":  house,
            "weeks": [int(round(x)) for x in weeks],
            "total": int(round(total))
        })

    # Also compute 3C average per week for comparison
    all_flocks = sorted(mdf[mdf["house"] != "3C_AVG"]["flock"].unique())
    prev3 = [f for f in all_flocks if f != flock][-3:]
    avg_weeks = [0.0] * num_weeks
    for w in range(num_weeks):
        day_start = w * 7
        day_end   = day_start + 6
        prev_sub  = mdf[
            (mdf["flock"].isin(prev3)) &
            (mdf["day"] >= day_start) &
            (mdf["day"] <= day_end) &
            (mdf["house"] != "3C_AVG")
        ]
        avg_weeks[w] = round(float(prev_sub["value"].mean()), 1) if not prev_sub.empty else 0

    return jsonify({
        "flock":      flock,
        "max_day":    max_day,
        "num_weeks":  num_weeks,
        "week_labels": [f"Week {i+1}" for i in range(num_weeks)],
        "houses":     houses_out,
        "avg_weeks":  avg_weeks
    })


# ── Route: cumulative mortality ────────────────────────────────────────────

@app.route("/api/mortality_cumulative")
def api_mortality_cumulative():
    """Running total mortality per house from day 0 to latest day."""
    mdf = data_store["daily_morts"]
    if mdf is None:
        return jsonify({"error": "No mortality data loaded"}), 400

    flock      = current_flock_id(mdf)
    flock_data = mdf[(mdf["flock"] == flock) & (mdf["house"] != "3C_AVG")].sort_values("day")

    houses_out = []
    for house in sorted(flock_data["house"].unique()):
        hd      = flock_data[flock_data["house"] == house].sort_values("day")
        running = 0.0
        points  = []
        for _, row in hd.iterrows():
            running += row["value"]
            points.append({"day": int(row["day"]), "value": int(round(running))})
        houses_out.append({"house": house, "points": points, "total": int(round(running))})

    return jsonify({"flock": flock, "houses": houses_out})


# ── Route: house trend ─────────────────────────────────────────────────────

@app.route("/api/house_trend")
def api_house_trend():
    house = request.args.get("house")
    flock = request.args.get("flock", type=int)
    if not house:
        return jsonify({"error": "house required"}), 400

    wdf = data_store["daily_weight"]
    mdf = data_store["daily_morts"]
    if wdf is None:
        return jsonify({"error": "No data loaded"}), 400

    if flock is None:
        flock = current_flock_id(wdf)

    hw  = wdf[(wdf["flock"] == flock) & (wdf["house"] == house)].sort_values("day")
    avg = wdf[wdf["house"] == "3C_AVG"].sort_values("day")

    weight_pts = [{"day": int(r["day"]), "value": round(r["value"], 1)} for _, r in hw.iterrows()]
    avg_pts    = [{"day": int(r["day"]), "value": round(r["value"], 1)} for _, r in avg.iterrows()]

    mort_pts = []
    if mdf is not None:
        hm = mdf[(mdf["flock"] == flock) & (mdf["house"] == house)].sort_values("day")
        mort_pts = [{"day": int(r["day"]), "value": round(r["value"], 1)} for _, r in hm.iterrows()]

    return jsonify({
        "house":  house,
        "flock":  flock,
        "weight": weight_pts,
        "avg":    avg_pts,
        "morts":  mort_pts
    })


# ── Route: available days ──────────────────────────────────────────────────

@app.route("/api/available_days")
def api_available_days():
    flock = request.args.get("flock", type=int)
    return jsonify({"days": get_available_days(flock)})


@app.route("/api/flocks")
def api_flocks():
    return jsonify({"flocks": get_all_flocks_summary()})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print("=" * 50)
    print("🐔  Poultry Dashboard")
    print(f"   http://127.0.0.1:{port}")
    print("=" * 50)
    app.run(host="0.0.0.0", port=port, debug=True)