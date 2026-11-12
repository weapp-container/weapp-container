FROM ubuntu:22.04@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956

ARG DEBIAN_FRONTEND=noninteractive
ARG RUST_VERSION=1.99.1
ARG NODE_VERSION=24.18.0
ENV PATH=/opt/rust/cargo/bin:/opt/node/bin:$PATH \
    RUSTUP_HOME=/opt/rust/rustup \
    CARGO_HOME=/opt/rust/cargo \
    CARGO_NET_RETRY=3

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl git xz-utils python3 pkg-config \
    clang libclang-dev cmake ninja-build libfontconfig1-dev libfreetype6-dev \
    libgl1-mesa-dev libegl1-mesa-dev libgtk-3-dev libxkbcommon-dev \
    xvfb xauth weston dbus-x11 binutils patchelf \
    && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --retry 3 https://sh.rustup.rs -o /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --profile minimal --default-toolchain ${RUST_VERSION} \
    && rm /tmp/rustup.sh
RUN mkdir /opt/node && cd /tmp \
    && curl --fail --location --retry 3 --retry-all-errors --continue-at - https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz -o node.tar.xz \
    && curl --fail --location --retry 3 https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt -o node-shasums.txt \
    && awk -v name=node-v${NODE_VERSION}-linux-x64.tar.xz '$2 == name {print $1 "  node.tar.xz"}' node-shasums.txt > node-checksum.txt \
    && test -s node-checksum.txt && sha256sum --check node-checksum.txt \
    && tar -xJf node.tar.xz --strip-components=1 -C /opt/node \
    && rm node.tar.xz node-shasums.txt node-checksum.txt
ENV RUSTUP_TOOLCHAIN=${RUST_VERSION}
WORKDIR /src
# Run with --platform linux/amd64. Clone the selected committed branch into
# this container; never mount the developer's Cargo registry as a writable cache.
CMD ["bash"]
