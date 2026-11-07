# Docker deployment

From the repository root, set the model variables in the host environment and start the
stack:

```sh
docker compose up --build -d
```

Open <http://localhost:8080>. The proxy is the only published service. It serves the
client as an SPA and forwards `/api/...` to the API after removing `/api`. MongoDB stays
on the Compose network and stores data in the `mongo_data` volume.

That "proxy only" rule is what makes the API's per-address request limit meaningful: the
API reads the client address from `X-Forwarded-For` (one trusted hop), so publishing the
API port directly would let a caller pick its own address and step around the limit.

The API reads `server/.env` when that file exists, and that file is the only source of the
model settings (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_TIMEOUT_MS`): they are
deliberately absent from `environment` in `docker-compose.yml`, because an empty default
there would override the file with `""`. A host shell variable of the same name does not
reach the container; write it into `server/.env`.
`CLIENT_ORIGIN` defaults to `http://localhost:8080`. Set it to the exact public URL used
by the browser, including scheme, host, and port. `MONGO_URL` is set to the Compose
MongoDB service and overrides any value in the env file.

`api` waits for the `mongo` healthcheck (`condition: service_healthy`), because the server
exits when the database is unreachable at startup, and every service uses
`restart: unless-stopped` so a reboot or a crash brings the stack back.

When using Strata on the host, set `LLM_BASE_URL` to an address reachable from the API
container, such as `http://host.docker.internal:8080/v1`. The Compose API service maps
`host.docker.internal` to the host gateway. Keep Strata bound to localhost on the host;
do not expose its listener publicly. If the container cannot reach that localhost-only
listener through the host gateway, run a host-side forwarder from the host gateway
interface to Strata's localhost listener and use the forwarder's host-gateway address as
`LLM_BASE_URL`.

To stop the containers while preserving MongoDB data:

```sh
docker compose down
```

`docker compose down -v` also deletes the MongoDB volume.

## Verified / Not verified here

`docker compose config` passes and shows only the proxy publishing a port. The client
build with `VITE_API_URL=/api` succeeds. The same-origin proxy path requires an API
available at `127.0.0.1:3000`; the connection probe returned `EPERM`, so the temporary
port-8081 proxy and its HTTP checks could not be run here. Nginx itself was not executed.
The actual `docker compose build` and `docker compose up -d` were not run
because this environment's user cannot access the Docker daemon; run them once on the
host with Docker access.
