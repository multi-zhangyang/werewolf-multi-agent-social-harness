"""Plot audited outcomes; no database writes or model calls."""
import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D

parser = argparse.ArgumentParser()
parser.add_argument("--audit", default="data/v5-verified-audit/repair-audit.json")
parser.add_argument("--output", default="data/v5-verified-audit")
parser.add_argument("--allow-incomplete", action="store_true")
args = parser.parse_args()
audit = json.loads(Path(args.audit).read_text(encoding="utf-8"))
if audit["status"] != "completed" and not args.allow_incomplete:
    raise SystemExit("The study is not completed; use --allow-incomplete for an explicitly labelled diagnostic plot.")
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False, "svg.fonttype": "none"})
mechanisms = [("hybrid", "Hybrid psychology"), ("instant", "No inertia"), ("off", "No psychology")]
conditions = ["silence", "apology", "compensation"]
metrics = [("returnedShare", "Round 2 returned share"), ("repair", "Round 2 compensation"), ("investment", "Round 3 investment")]
fig, axes = plt.subplots(3, 3, figsize=(13, 10), sharex=True, sharey="row")
lookup = {g["key"]: g["metrics"] for g in audit["distributions"]}
repair_max = max((value for g in audit["distributions"] for value in g["metrics"]["repair"]["values"]), default=0)
for col, (mechanism, title) in enumerate(mechanisms):
    for row, (metric, label) in enumerate(metrics):
        ax = axes[row, col]
        for x, condition in enumerate(conditions):
            for trait, offset, marker, fill in [(0.2, -0.16, "o", "white"), (0.8, 0.16, "s", "black")]:
                result = lookup.get(f"{mechanism}:{condition}:{trait}", {}).get(metric, {})
                values = result.get("values", [])
                positions = [x + offset + (i - (len(values) - 1) / 2) * .035 for i in range(len(values))]
                ax.scatter(positions, values, marker=marker, s=28, facecolor=fill, edgecolor="black", linewidth=.8, zorder=3)
                summary = result.get("summary")
                if summary:
                    ax.plot(x + offset, summary["mean"], marker="_", markersize=12, color="black", zorder=4)
                    if summary["low"] is not None:
                        ax.errorbar(x + offset, summary["mean"], yerr=[[summary["mean"] - summary["low"]], [summary["high"] - summary["mean"]]], fmt="none", color="black", linewidth=.85, capsize=2)
        ax.set_xlim(-.5, 2.5)
        ax.grid(axis="y", color=".9", linewidth=.7, zorder=0)
        ax.set_xticks(range(3), ["No response", "Apology", "Apology + 9"])
        if row == 0:
            ax.set_title(title, pad=13)
            ax.set_ylim(-.05, 1.05)
        if row == 1:
            ax.set_ylim(-.15, max(1, repair_max * 1.12))
        if row == 2:
            ax.set_ylim(-.5, 10.5)
        if col == 0:
            ax.set_ylabel(label)
fig.suptitle(f"Betrayal and repair | {audit['completed']}/{audit['planned']} branches completed", fontsize=16, y=.98)
fig.legend(handles=[Line2D([], [], marker="o", markerfacecolor="white", color="black", linestyle="none", label="Agreeableness 0.2"), Line2D([], [], marker="s", color="black", linestyle="none", label="Agreeableness 0.8"), Line2D([], [], marker="_", markersize=12, color="black", linestyle="none", label="Mean and descriptive 95% bootstrap interval")], loc="upper center", bbox_to_anchor=(.5, .948), ncol=3, frameon=False)
fig.text(.06, .035, "Dots show individual branches. Failed/missing trials are excluded from values, never converted to zero.\nCompensation changes both resources and social signals. Small exploratory samples; no significance claim.", fontsize=9, color=".3")
fig.text(.06, .012, f"Study: {audit['id']}  |  Runtime: {audit['sourceHash'][:12]}", fontsize=8, color=".4")
if audit["status"] != "completed":
    fig.text(.5, .5, "INCOMPLETE DIAGNOSTIC", ha="center", rotation=25, fontsize=34, color=".6", alpha=.4)
fig.subplots_adjust(top=.87, bottom=.115, left=.08, right=.98, wspace=.12, hspace=.22)
for extension in ["png", "svg", "pdf"]:
    fig.savefig(out / f"behavior-distributions.{extension}", dpi=180, facecolor="white")
plt.close(fig)
print(json.dumps({"status": audit["status"], "completed": audit["completed"], "output": str(out.resolve())}))
