"use strict";

// Health scoring.
//
// A score is a weighted average of individual checks, and every check reports
// back what it looked at and what it found. The UI shows that list, so a "64/100
// Privacy" is always traceable to the specific settings that produced it.
//
// evaluate() returns:
//   null      -> could not be determined (excluded from the score entirely,
//                so a missing reading never silently counts as a failure)
//   0..1      -> how well this check passes
//
// This module is pure: it takes an analysis object and returns numbers. That
// makes it testable without touching a real machine.

// Windows' own plan GUIDs — stable across languages, unlike the plan names.
const BALANCED = "381b4222-f694-41f0-9685-ff5bb260df2e";
const POWER_SAVER = "a1841308-3541-4fab-bc81-f71556f20b4a";

const pass = (b) => (b === null || b === undefined ? null : b ? 1 : 0);

// Distinguishes "this section was read and the value is absent" from "the whole
// section is missing". The first is a real finding (an absent registry value
// usually means the Windows default is in effect); the second is unknown, and
// scoring it as a failure would show an alarming 0 for data we never read.
const inSection = (section, evaluate) => (section ? evaluate(section) : null);

// Maps a measured value onto 0..1, where `good` scores 1 and `bad` scores 0.
function scale(value, bad, good) {
    if (value === null || value === undefined || Number.isNaN(value)) return null;
    if (good > bad) return Math.max(0, Math.min(1, (value - bad) / (good - bad)));
    return Math.max(0, Math.min(1, (bad - value) / (bad - good)));
}

const CATEGORIES = {
    performance: [
        {
            id: "ssd",
            weight: 3,
            label: "System drive is an SSD",
            evaluate: (a) => (a.systemDriveType ? pass(a.systemDriveType === "SSD") : null),
            detail: (a) => a.systemDriveType || null,
        },
        {
            id: "diskFree",
            weight: 2,
            label: "Free space on the system drive",
            evaluate: (a) => scale(sysDrive(a)?.freePct ?? null, 5, 25),
            detail: (a) => (sysDrive(a) ? `${sysDrive(a).freePct}% free` : null),
        },
        {
            id: "startupCount",
            weight: 2,
            label: "Number of startup programs",
            evaluate: (a) => scale(a.startup ? a.startup.length : null, 15, 4),
            detail: (a) => (a.startup ? `${a.startup.length} entries` : null),
        },
        {
            id: "ramSpeed",
            weight: 2,
            label: "RAM runs at its rated speed (XMP/EXPO)",
            evaluate: (a) =>
                a.ram && a.ram.ratedMHz && a.ram.configuredMHz
                    ? pass(a.ram.configuredMHz >= a.ram.ratedMHz)
                    : null,
            detail: (a) =>
                a.ram && a.ram.configuredMHz ? `${a.ram.configuredMHz} / ${a.ram.ratedMHz} MHz` : null,
        },
        {
            id: "ramAmount",
            weight: 2,
            label: "Installed memory",
            evaluate: (a) => scale(a.ram ? a.ram.totalGB : null, 4, 16),
            detail: (a) => (a.ram ? `${a.ram.totalGB} GB` : null),
        },
        {
            id: "uptime",
            weight: 1,
            label: "Time since last restart",
            evaluate: (a) => scale(a.windows ? a.windows.uptimeHours : null, 336, 24),
            detail: (a) => (a.windows?.uptimeHours != null ? `${a.windows.uptimeHours} h` : null),
        },
    ],

    privacy: [
        {
            id: "telemetry",
            weight: 3,
            label: "Diagnostic data level",
            evaluate: (a) => inSection(a.privacy, (p) => pass(p.telemetryLevel === 0)),
            detail: (a) =>
                a.privacy?.telemetryLevel == null ? "Not configured (Windows default)" : `Level ${a.privacy.telemetryLevel}`,
        },
        {
            id: "diagTrack",
            weight: 3,
            label: "Connected User Experiences and Telemetry service",
            evaluate: (a) => pass(a.privacy?.diagTrackStart ? a.privacy.diagTrackStart === "Disabled" : null),
            detail: (a) => a.privacy?.diagTrackStart || null,
        },
        {
            id: "advertisingId",
            weight: 2,
            label: "Advertising ID",
            evaluate: (a) => inSection(a.privacy, (p) => pass(p.advertisingId === 0)),
            detail: (a) => (a.privacy?.advertisingId === 0 ? "Disabled" : "Enabled"),
        },
        {
            id: "tailored",
            weight: 2,
            label: "Tailored experiences using diagnostic data",
            evaluate: (a) => inSection(a.privacy, (p) => pass(p.tailoredExperience === 0)),
            detail: (a) => (a.privacy?.tailoredExperience === 0 ? "Disabled" : "Enabled"),
        },
        {
            id: "silentApps",
            weight: 2,
            label: "Automatic installation of suggested apps",
            evaluate: (a) => inSection(a.privacy, (p) => pass(p.silentAppInstall === 0)),
            detail: (a) => (a.privacy?.silentAppInstall === 0 ? "Disabled" : "Enabled"),
        },
        {
            id: "suggestions",
            weight: 1,
            label: "Start menu suggestions",
            evaluate: (a) => inSection(a.privacy, (p) => pass(p.startSuggestions === 0)),
            detail: (a) => (a.privacy?.startSuggestions === 0 ? "Disabled" : "Enabled"),
        },
        {
            id: "activityFeed",
            weight: 1,
            label: "Activity history",
            evaluate: (a) => inSection(a.privacy, (p) => pass(p.activityFeed === 0)),
            detail: (a) => (a.privacy?.activityFeed === 0 ? "Disabled" : "Enabled"),
        },
    ],

    debloat: [
        {
            id: "appxCount",
            weight: 3,
            label: "Preinstalled Store apps",
            evaluate: (a) => scale(a.installedApps ? a.installedApps.length : null, 70, 25),
            detail: (a) => (a.installedApps ? `${a.installedApps.length} packages` : null),
        },
        {
            id: "xbox",
            weight: 2,
            label: "Xbox components",
            evaluate: (a) => scale(a.xboxApps ? a.xboxApps.length : null, 5, 0),
            detail: (a) => (a.xboxApps ? `${a.xboxApps.length} installed` : null),
        },
        {
            id: "oneDrive",
            weight: 1,
            label: "OneDrive",
            evaluate: (a) => pass(a.components ? !a.components.oneDriveInstalled : null),
            detail: (a) =>
                a.components?.oneDriveInstalled
                    ? a.components.oneDriveRunning
                        ? "Installed and running"
                        : "Installed"
                    : "Not installed",
        },
        {
            id: "copilot",
            weight: 1,
            label: "Copilot",
            evaluate: (a) => pass(a.components ? !a.components.copilotPresent : null),
            detail: (a) => (a.components?.copilotPresent ? "Installed" : "Not installed"),
        },
        {
            id: "startupLoad",
            weight: 2,
            label: "Programs starting with Windows",
            evaluate: (a) => scale(a.startup ? a.startup.length : null, 15, 4),
            detail: (a) => (a.startup ? `${a.startup.length} entries` : null),
        },
        {
            id: "scheduledTasks",
            weight: 1,
            label: "Active scheduled tasks",
            evaluate: (a) => scale(a.scheduledTaskCount, 250, 100),
            detail: (a) => (a.scheduledTaskCount != null ? `${a.scheduledTaskCount} enabled` : null),
        },
    ],

    gaming: [
        {
            id: "gameDvr",
            weight: 3,
            label: "Xbox Game DVR background recording",
            evaluate: (a) => (a.gameDvr === null || a.gameDvr === undefined ? null : pass(!a.gameDvr)),
            detail: (a) => (a.gameDvr ? "Enabled — records in the background" : "Disabled"),
        },
        {
            id: "refreshRate",
            weight: 3,
            label: "Monitor runs at its highest refresh rate",
            evaluate: (a) => {
                const g = a.gpus?.[0];
                if (!g || !g.maxRefresh || !g.currentRefresh) return null;
                return pass(g.currentRefresh >= g.maxRefresh);
            },
            detail: (a) => {
                const g = a.gpus?.[0];
                return g?.currentRefresh ? `${g.currentRefresh} / ${g.maxRefresh} Hz` : null;
            },
        },
        {
            id: "gameMode",
            weight: 2,
            label: "Windows Game Mode",
            evaluate: (a) => pass(a.gameMode),
            detail: (a) => (a.gameMode ? "Enabled" : "Disabled"),
        },
        {
            id: "hags",
            weight: 2,
            label: "Hardware-accelerated GPU scheduling",
            evaluate: (a) => (a.hags === null || a.hags === undefined ? null : pass(a.hags === 2)),
            detail: (a) => (a.hags === 2 ? "Enabled" : "Disabled"),
        },
        {
            id: "gpuDriver",
            weight: 2,
            label: "GPU driver age",
            evaluate: (a) => scale(a.gpus?.[0]?.driverAgeDays ?? null, 365, 60),
            detail: (a) =>
                a.gpus?.[0]?.driverAgeDays != null ? `${a.gpus[0].driverAgeDays} days old` : null,
        },
        {
            id: "powerPlan",
            weight: 2,
            label: "Power plan",
            evaluate: (a) => {
                if (!a.powerPlan?.guid) return null;
                const guid = a.powerPlan.guid.toLowerCase();
                if (guid === POWER_SAVER) return 0;
                if (guid === BALANCED) return 0.5;
                return 1; // High performance, Ultimate, or an OEM/custom plan
            },
            detail: (a) => a.powerPlan?.name || null,
        },
    ],

    security: [
        {
            id: "defenderRealtime",
            weight: 4,
            label: "Real-time protection",
            evaluate: (a) => pass(a.defender?.available ? a.defender.realtimeEnabled : null),
            detail: (a) => (a.defender?.realtimeEnabled ? "Active" : "Off"),
        },
        {
            id: "firewall",
            weight: 3,
            label: "Windows Firewall on all profiles",
            evaluate: (a) => pass(a.firewall),
            detail: (a) => (a.firewall === null ? null : a.firewall ? "All profiles on" : "A profile is off"),
        },
        {
            id: "uac",
            weight: 3,
            label: "User Account Control",
            evaluate: (a) => pass(a.uac?.enabled),
            detail: (a) => (a.uac?.enabled ? "Enabled" : "Disabled"),
        },
        {
            id: "secureBoot",
            weight: 3,
            label: "Secure Boot",
            evaluate: (a) => pass(a.secureBoot),
            detail: (a) => (a.secureBoot === null ? null : a.secureBoot ? "Enabled" : "Disabled"),
        },
        {
            id: "tamperProtection",
            weight: 2,
            label: "Tamper protection",
            evaluate: (a) => pass(a.defender?.available ? a.defender.tamperProtection : null),
            detail: (a) => (a.defender?.tamperProtection ? "Enabled" : "Disabled"),
        },
        {
            id: "hvci",
            weight: 2,
            label: "Memory integrity (Core isolation)",
            evaluate: (a) => (a.hvci === null || a.hvci === undefined ? null : pass(a.hvci === 1)),
            detail: (a) => (a.hvci === 1 ? "Enabled" : "Disabled"),
        },
        {
            id: "windowsUpdate",
            weight: 2,
            label: "Windows Update service",
            evaluate: (a) =>
                a.windowsUpdate?.serviceStartMode
                    ? pass(a.windowsUpdate.serviceStartMode !== "Disabled")
                    : null,
            detail: (a) => a.windowsUpdate?.serviceStartMode || null,
        },
        {
            id: "signatureAge",
            weight: 1,
            label: "Virus definition age",
            evaluate: (a) => scale(a.defender?.signatureAgeDays ?? null, 14, 1),
            detail: (a) =>
                a.defender?.signatureAgeDays != null ? `${a.defender.signatureAgeDays} days` : null,
        },
    ],
};

function sysDrive(a) {
    if (!Array.isArray(a.drives)) return null;
    return a.drives.find((d) => /^C:/i.test(d.letter)) || a.drives[0] || null;
}

function scoreCategory(checks, analysis) {
    let weighted = 0;
    let knownWeight = 0;
    const results = [];

    for (const check of checks) {
        let value = null;
        let detail = null;
        try {
            value = check.evaluate(analysis);
            detail = check.detail ? check.detail(analysis) : null;
        } catch {
            value = null; // a malformed analysis must not break scoring
        }
        if (value !== null) {
            weighted += value * check.weight;
            knownWeight += check.weight;
        }
        results.push({
            id: check.id,
            label: check.label,
            weight: check.weight,
            detail,
            value,
            status: value === null ? "unknown" : value >= 0.99 ? "good" : value >= 0.5 ? "fair" : "poor",
        });
    }

    return {
        // With nothing measurable there is no score — the UI shows "—", not 0,
        // because 0 would read as "your system is terrible".
        score: knownWeight === 0 ? null : Math.round((weighted / knownWeight) * 100),
        checks: results,
        measured: results.filter((r) => r.value !== null).length,
        total: results.length,
    };
}

function computeScores(analysis) {
    const out = {};
    for (const [name, checks] of Object.entries(CATEGORIES)) {
        out[name] = scoreCategory(checks, analysis || {});
    }
    const known = Object.values(out).filter((c) => c.score !== null);
    out.overall = known.length
        ? Math.round(known.reduce((a, c) => a + c.score, 0) / known.length)
        : null;
    return out;
}

module.exports = { computeScores, scoreCategory, CATEGORIES, scale, sysDrive };
