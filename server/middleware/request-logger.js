// Log request metadata only. Never inspect headers, query values, bodies, or response content.
function requestLogger(write = console.log) {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.once("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const userId = req.user?.id ?? req.user?._id ?? "-";
      write(`${req.method} ${req.path} ${res.statusCode} ${durationMs.toFixed(1)}ms user=${userId}`);
    });
    next();
  };
}

module.exports = { requestLogger };
