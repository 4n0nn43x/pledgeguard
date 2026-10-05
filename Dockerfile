# PledgeGuard: the site, the dashboard and its actions (frontend/server.mjs), and the registry automation
# (backend/registry.mjs, same image, another command). No dependency.
# Base pinned by digest (node:22-bookworm-slim). The DevNet credentials are mounted at run time, never copied in.
FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
WORKDIR /app
COPY backend/oidc.mjs backend/registry.mjs ./backend/
COPY frontend ./frontend
COPY site ./site
# /data is the registry automation's volume, created here so a new volume inherits the owner.
RUN mkdir /data && chown node:node /data
USER node
ENV ENV_FILE=/run/secrets/devnet.env PORT=8090
EXPOSE 8090
CMD ["node", "frontend/server.mjs"]
