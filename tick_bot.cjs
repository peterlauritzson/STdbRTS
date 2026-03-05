const { spawn } = require("child_process");

console.log("Starting server side ticker (10 ticks/sec)..");
setInterval(() => {
    // Run CLI to quietly call game_tick externally to act as our "server" loop
    const child = spawn(process.platform === "win32" ? "spacetime.exe" : "spacetime", ["call", "server", "game_tick"]);
    child.on('error', (err) => console.error("Ticker error:", err.message));
}, 100);
