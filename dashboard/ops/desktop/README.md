# Sandbox desktop build prerequisites

On the Arch Linux host, provide the `archlinux-keyring` and `manjaro-keyring` packages before running `build.sh`. The preparation script reads `archlinux.gpg` and `manjaro.gpg` from `/usr/share/pacman/keyrings/`.

The [package lock](packages.lock.json) pins a distribution snapshot for the isolated desktop. Its Xvfb package requires a Manjaro signing key. The builder checks the SHA-256 digest and package signature before extracting each archive into the desktop runtime.
