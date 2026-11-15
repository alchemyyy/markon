// Added to gh-gfm-preview's internal/app package by markon's scripts/gfm/vendor.mjs,
// which also patches ToHTML to append ExtraParserOptions to the parser options it builds.
// Everything else about the rendering stays gh-gfm-preview's own.

package app

import "github.com/yuin/goldmark/parser"

// ExtraParserOptions are appended to the parser options of every ToHTML call.
var ExtraParserOptions []parser.Option
