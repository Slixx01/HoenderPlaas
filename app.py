from flask import Flask, request, jsonify, send_from_directory
import pandas as pd
import numpy as np
import os
import tempfile
from io import BytesIO
import traceback

# Configure Flask to serve from public folder
app = Flask(__name__, static_folder='public', static_url_path='/')
app.config['STATIC_FOLDER'] = os.path.join(os.path.dirname(__file__), 'public')

# Global data store
data_store = {
    "daily_weight": None,
    "daily_morts": None,
    "filename": None
}

def parse_excel(file_stream):
    """Parse the Excel workbook and extract structured data from sheets 3 & 4."""
    try:
        xl = pd.ExcelFile(file_stream, engine='openpyxl')
        sheets = xl.sheet_names
        
        if len(sheets) < 4:
            raise ValueError(f"Expected at least 4 sheets, found {len(sheets)}. Sheets: {sheets}")

        # Expect sheet index 2 = Dayly Weight, index 3 = Daily Morts
        weight_sheet = sheets[2]
        morts_sheet = sheets[3]

        weight_data = parse_daily_sheet(file_stream, weight_sheet, "weight")
        morts_data = parse_daily_sheet(file_stream, morts_sheet, "morts")

        return weight_data, morts_data
    except Exception as e:
        raise Exception(f"Excel parsing failed: {str(e)}")


def parse_daily_sheet(file_stream, sheet_name, data_type):
    """
    Parse a daily data sheet. Each flock block starts with a flock number in col 0,
    followed by rows H1..H10 and an average row. Days are columns starting at col 2.
    Returns a list of dicts: {flock, house, day, value}
    """
    try:
        df = pd.read_excel(file_stream, sheet_name=sheet_name, header=None, engine='openpyxl')

        # Row 2 (index 2) contains day numbers starting at col 2
        day_row = df.iloc[2, 2:]
        days = []
        for val in day_row:
            try:
                days.append(int(float(val)))
            except (ValueError, TypeError):
                days.append(None)

        records = []
        current_flock = None

        for i, row in df.iterrows():
            flock_val = row[0]
            house_val = row[1]

            if pd.notna(flock_val) and str(flock_val) not in ['nan']:
                try:
                    current_flock = int(float(flock_val))
                except (ValueError, TypeError):
                    pass

            if pd.isna(house_val):
                continue

            house_str = str(house_val).strip()
            if house_str == '3 C Avg':
                house_str = '3C_AVG'
            elif not (house_str.startswith('H') and house_str[1:].isdigit()):
                continue

            if current_flock is None:
                continue

            for col_offset, day in enumerate(days):
                if day is None:
                    continue
                col_idx = col_offset + 2
                if col_idx >= len(row):
                    continue
                val = row[col_idx]
                if pd.isna(val):
                    continue
                try:
                    val = float(val)
                except (ValueError, TypeError):
                    continue

                records.append({
                    "flock": current_flock,
                    "house": house_str,
                    "day": day,
                    "value": val
                })

        return pd.DataFrame(records)
    except Exception as e:
        raise Exception(f"Failed to parse sheet '{sheet_name}': {str(e)}")


def get_three_cycle_avg(df_sheet):
    """Extract the 3-cycle average rows separately."""
    avg_rows = df_sheet[df_sheet["house"] == "3C_AVG"]
    return avg_rows


def query_by_day(day, threshold_pct=None):
    """
    Query weight data for a given day.
    Returns per-house value for the current flock (185) vs 3-cycle average,
    and calculates % difference.
    """
    weight_df = data_store["daily_weight"]
    morts_df = data_store["daily_morts"]

    if weight_df is None:
        return {"error": "No data loaded"}

    # Current flock = highest flock number
    all_flocks = sorted(weight_df[weight_df["house"] != "3C_AVG"]["flock"].unique())
    current_flock = max(all_flocks)

    # Get 3C average for this day
    avg_data = weight_df[(weight_df["house"] == "3C_AVG") & (weight_df["day"] == day)]
    if avg_data.empty:
        # Calculate it from previous 3 flocks
        prev_flocks = [f for f in all_flocks if f != current_flock][-3:]
        avg_data_calc = weight_df[
            (weight_df["flock"].isin(prev_flocks)) &
            (weight_df["day"] == day) &
            (weight_df["house"] != "3C_AVG")
        ]
        if avg_data_calc.empty:
            avg_value = None
        else:
            avg_value = avg_data_calc["value"].mean()
    else:
        avg_value = float(avg_data.iloc[0]["value"]) if not avg_data.empty else None

    # Get current flock data for this day
    current_data = weight_df[
        (weight_df["flock"] == current_flock) &
        (weight_df["day"] == day) &
        (weight_df["house"] != "3C_AVG")
    ]

    # Also get morts for same day/flock
    current_morts = None
    if morts_df is not None:
        current_morts = morts_df[
            (morts_df["flock"] == current_flock) &
            (morts_df["day"] == day) &
            (morts_df["house"] != "3C_AVG")
        ]

    results = []
    for _, row in current_data.iterrows():
        house = row["house"]
        val = row["value"]
        pct_diff = None
        status = "ok"

        if avg_value and avg_value != 0:
            pct_diff = ((val - avg_value) / avg_value) * 100

        if threshold_pct is not None and pct_diff is not None:
            if pct_diff < -threshold_pct:
                status = "below"
            elif pct_diff > threshold_pct:
                status = "above"

        mort_val = None
        if current_morts is not None:
            mort_row = current_morts[current_morts["house"] == house]
            if not mort_row.empty:
                mort_val = float(mort_row.iloc[0]["value"])

        results.append({
            "house": house,
            "weight": round(val, 1),
            "avg_weight": round(avg_value, 1) if avg_value else None,
            "pct_diff": round(pct_diff, 2) if pct_diff is not None else None,
            "status": status,
            "morts": round(mort_val, 0) if mort_val else None
        })

    results.sort(key=lambda x: x["house"])

    return {
        "flock": int(current_flock),
        "day": day,
        "three_cycle_avg": round(avg_value, 1) if avg_value else None,
        "houses": results,
        "below_avg_count": sum(1 for r in results if r["status"] == "below"),
        "above_avg_count": sum(1 for r in results if r["status"] == "above"),
    }


def get_all_flocks_summary():
    """Return summary of all flocks available."""
    weight_df = data_store["daily_weight"]
    if weight_df is None:
        return []
    flocks = sorted(weight_df[weight_df["house"] != "3C_AVG"]["flock"].unique())
    summary = []
    for f in flocks:
        flock_data = weight_df[(weight_df["flock"] == f) & (weight_df["house"] != "3C_AVG")]
        max_day = int(flock_data["day"].max()) if not flock_data.empty else 0
        summary.append({"flock": int(f), "max_day": max_day})
    return summary


def get_house_trend(house, flock=None):
    """Get full weight and morts trend for a specific house."""
    weight_df = data_store["daily_weight"]
    morts_df = data_store["daily_morts"]

    if weight_df is None:
        return {"error": "No data loaded"}

    all_flocks = sorted(weight_df[weight_df["house"] != "3C_AVG"]["flock"].unique())
    if flock is None:
        flock = max(all_flocks)

    house_weight = weight_df[
        (weight_df["flock"] == flock) &
        (weight_df["house"] == house)
    ].sort_values("day")

    avg_weight = weight_df[
        (weight_df["house"] == "3C_AVG")
    ].sort_values("day")

    weight_points = [{"day": int(r["day"]), "value": round(r["value"], 1)}
                     for _, r in house_weight.iterrows()]
    avg_points = [{"day": int(r["day"]), "value": round(r["value"], 1)}
                  for _, r in avg_weight.iterrows()]

    mort_points = []
    if morts_df is not None:
        house_morts = morts_df[
            (morts_df["flock"] == flock) &
            (morts_df["house"] == house)
        ].sort_values("day")
        mort_points = [{"day": int(r["day"]), "value": round(r["value"], 1)}
                       for _, r in house_morts.iterrows()]

    return {
        "house": house,
        "flock": int(flock),
        "weight": weight_points,
        "avg": avg_points,
        "morts": mort_points
    }


def get_available_days(flock=None):
    """Return all days available in the current flock."""
    weight_df = data_store["daily_weight"]
    if weight_df is None:
        return []
    all_flocks = sorted(weight_df[weight_df["house"] != "3C_AVG"]["flock"].unique())
    if flock is None:
        flock = max(all_flocks)
    days = sorted(weight_df[
        (weight_df["flock"] == flock) &
        (weight_df["house"] != "3C_AVG")
    ]["day"].unique().tolist())
    return [int(d) for d in days]


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.route("/")
@app.route("/index.html")
def index():
    return send_from_directory(app.static_folder, 'index.html')


@app.route("/<path:filename>")
def serve_static(filename):
    """Serve static files from public folder."""
    return send_from_directory(app.static_folder, filename)


@app.route("/upload", methods=["POST"])
def upload():
    try:
        if "file" not in request.files:
            return jsonify({"error": "❌ No file uploaded"}), 400

        file = request.files["file"]
        
        if not file or file.filename == "":
            return jsonify({"error": "❌ No file selected"}), 400
        
        if not file.filename.lower().endswith((".xlsx", ".xls")):
            return jsonify({"error": f"❌ Invalid file type. Please upload an Excel file (.xlsx or .xls), got: {file.filename}"}), 400

        # Read file into memory (BytesIO)
        file_stream = BytesIO(file.read())
        file.seek(0)

        # Parse Excel file
        weight_df, morts_df = parse_excel(file_stream)
        
        if weight_df.empty:
            return jsonify({"error": "❌ No weight data found in Excel file"}), 400
        
        # Store in memory
        data_store["daily_weight"] = weight_df
        data_store["daily_morts"] = morts_df
        data_store["filename"] = file.filename

        flocks = get_all_flocks_summary()
        days = get_available_days()

        return jsonify({
            "success": True,
            "filename": file.filename,
            "flocks": flocks,
            "available_days": days,
            "weight_records": len(weight_df),
            "morts_records": len(morts_df) if morts_df is not None else 0
        }), 200
        
    except Exception as e:
        error_msg = str(e)
        print(f"❌ Upload error: {error_msg}")
        print(traceback.format_exc())
        return jsonify({"error": f"❌ Upload failed: {error_msg}"}), 500


@app.route("/api/query_day", methods=["GET"])
def api_query_day():
    day = request.args.get("day", type=int)
    threshold = request.args.get("threshold", default=5.0, type=float)

    if day is None:
        return jsonify({"error": "Day parameter required"}), 400

    result = query_by_day(day, threshold)
    return jsonify(result)


@app.route("/api/house_trend", methods=["GET"])
def api_house_trend():
    house = request.args.get("house")
    flock = request.args.get("flock", type=int)
    if not house:
        return jsonify({"error": "House parameter required"}), 400
    result = get_house_trend(house, flock)
    return jsonify(result)


@app.route("/api/available_days", methods=["GET"])
def api_available_days():
    days = get_available_days()
    return jsonify({"days": days})


@app.route("/api/flocks", methods=["GET"])
def api_flocks():
    return jsonify({"flocks": get_all_flocks_summary()})


@app.route("/api/all_days_report", methods=["GET"])
def api_all_days_report():
    """Return a summary report across all days for the current flock."""
    weight_df = data_store["daily_weight"]
    if weight_df is None:
        return jsonify({"error": "No data loaded"}), 400

    threshold = request.args.get("threshold", default=5.0, type=float)
    days = get_available_days()
    report = []
    for day in days:
        result = query_by_day(day, threshold)
        report.append(result)
    return jsonify({"report": report})


if __name__ == "__main__":
    # Use PORT env var for hosting platforms; default to 5000 for local dev
    port = int(os.environ.get("PORT", 5000))
    debug_mode = os.environ.get("FLASK_DEBUG", "0") == "1"
    print("=" * 50)
    print("🐔  Poultry Dashboard")
    print("=" * 50)
    print(f"Open your browser at: http://127.0.0.1:{port}")
    print("=" * 50)
    app.run(host="0.0.0.0", port=port, debug=debug_mode)