# AL2023 ARM64 Lambda wheels only. Fail rather than package macOS native binaries.
.PHONY: build-WasteLensApiFunction
build-WasteLensApiFunction:
	python3 -m pip install --disable-pip-version-check --no-compile --implementation cp --python-version 3.13 --platform manylinux_2_34_aarch64 --platform manylinux_2_28_aarch64 --platform manylinux2014_aarch64 --only-binary=:all: --target "$(ARTIFACTS_DIR)" -r requirements.txt
	python3 scripts/package_source.py "$(ARTIFACTS_DIR)"
