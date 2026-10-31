# Ink OS deployment

Container and cloud deployment tooling for a clean Ink OS instance. Installations start with zero apps.

With the platform checkout next to this repository:

```sh
docker compose up --build -d
```

The local container desktop is configured for `http://os.ink.localhost:8080`. Private instance credentials live in the named data volume. App releases have separate hostnames routed through the platform gateway.

Container execution validation, backend containers, HTTPS provisioning, and scalable cloud setup are under development. Do not treat source configuration checks as proof of a successful deployment.
