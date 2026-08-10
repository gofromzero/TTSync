package httpapi

import (
	"embed"
	"io/fs"
)

//go:embed web/dist/*
var embeddedWeb embed.FS

func WebAssets() fs.FS {
	assets, err := fs.Sub(embeddedWeb, "web/dist")
	if err != nil {
		panic(err)
	}
	return assets
}
