FROM alpine:3.8 as kubectl
ADD https://storage.googleapis.com/kubernetes-release/release/v1.15.3/bin/linux/amd64/kubectl /usr/local/bin/kubectl
RUN set -x && \
    apk add --no-cache curl ca-certificates && \
    chmod +x /usr/local/bin/kubectl && \
    \
    # Basic check it works.
    kubectl version --client
FROM mhart/alpine-node:10 as base
WORKDIR /usr/src
COPY package.json yarn.lock /usr/src/
RUN yarn --production
COPY . .

FROM mhart/alpine-node:base-10
WORKDIR /usr/src

COPY --from=kubectl /usr/local/bin/kubectl /usr/src/kubectl
RUN apk add --update --no-cache docker curl ca-certificates
ENV NODE_ENV="production"
COPY --from=base /usr/src .
CMD ["node", "index.js"]