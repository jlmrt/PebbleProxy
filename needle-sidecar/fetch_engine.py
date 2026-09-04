import hashlib
import os
import sys
import tempfile
import urllib.request
import zipfile


ENGINES = {
    "amd64": (
        "manylinux2014_x86_64",
        "13a84e6c73095fd175b11d46a30a984b62123d94421b769c107074aff7f65c2b",
    ),
    "arm64": (
        "manylinux2014_aarch64",
        "e655a13f9d3239e601936ff2d0f6acafd8f6020aaf7b1862ce4fceefacfd6556",
    ),
}


def main():
    architecture, destination = sys.argv[1:3]
    if architecture not in ENGINES:
        raise SystemExit(f"unsupported target architecture: {architecture}")
    platform_tag, expected_hash = ENGINES[architecture]
    filename = f"cactus_needle-2.0.4-py3-none-{platform_tag}.whl"
    url = f"https://huggingface.co/Cactus-Compute/needle2/resolve/main/python/{filename}?download=true"
    with tempfile.NamedTemporaryFile() as download:
        with urllib.request.urlopen(url, timeout=120) as response:
            while chunk := response.read(1024 * 1024):
                download.write(chunk)
        download.flush()
        download.seek(0)
        digest = hashlib.file_digest(download, "sha256").hexdigest()
        if digest != expected_hash:
            raise SystemExit("Needle engine digest did not match the pinned release")
        download.seek(0)
        with zipfile.ZipFile(download) as archive:
            engine = archive.read("needle/libneedle.so")
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    with open(destination, "wb") as output:
        output.write(engine)


if __name__ == "__main__":
    main()
