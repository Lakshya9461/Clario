require("dotenv").config();

const app = require("./app");

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`clario server listening on http://127.0.0.1:${port}`);
});
