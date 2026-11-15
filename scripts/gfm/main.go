//go:build js && wasm

// markon's GitHub renderer: gh-gfm-preview's own Markdown renderer
// (internal/app.ToHTML in GitHub Flavored Markdown mode), built for WebAssembly so it renders offline.
// scripts/gfm/vendor.mjs copies this file to cmd/markon-wasm in a pinned gh-gfm-preview checkout
// and builds it there, since it imports that module's internal package.
//
// Exposes markonGfmRender(markdown string, lineOffset int) -> {html} | {error} on the global object.
// Every top-level block in the HTML carries data-source-line, the 1-based line it starts on (plus lineOffset),
// so the preview can follow the editor's scroll.
package main

import (
	"sort"
	"strconv"
	"syscall/js"

	"github.com/andybalholm/crlf"
	"github.com/thiagokokada/gh-gfm-preview/internal/app"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
	"golang.org/x/text/transform"
)

const sourceLineAttribute = "data-source-line"

// sourceLines marks top-level blocks with the line they start on.
type sourceLines struct {
	offset int
}

func (s *sourceLines) Transform(document *ast.Document, reader text.Reader, _ parser.Context) {
	source := reader.Source()
	starts := []int{0}
	for index, character := range source {
		if character == '\n' {
			starts = append(starts, index+1)
		}
	}
	lineOf := func(offset int) int {
		// The number of lines starting at or before offset is its 1-based line
		return sort.SearchInts(starts, offset+1)
	}
	for node := document.FirstChild(); node != nil; node = node.NextSibling() {
		line := 0
		if fenced, ok := node.(*ast.FencedCodeBlock); ok {
			// The opening fence sits a line above the code
			if fenced.Info != nil {
				line = lineOf(fenced.Info.Segment.Start)
			} else if fenced.Lines().Len() > 0 {
				line = lineOf(fenced.Lines().At(0).Start) - 1
			}
		} else if offset, found := firstOffset(node); found {
			line = lineOf(offset)
		}
		if line > 0 {
			node.SetAttributeString(sourceLineAttribute, []byte(strconv.Itoa(line+s.offset)))
		}
	}
}

// firstOffset finds where a node's source text begins:
// its first line, or that of its first descendant with one.
func firstOffset(node ast.Node) (int, bool) {
	if node.Type() == ast.TypeBlock && node.Lines().Len() > 0 {
		return node.Lines().At(0).Start, true
	}
	if textNode, ok := node.(*ast.Text); ok {
		return textNode.Segment.Start, true
	}
	for child := node.FirstChild(); child != nil; child = child.NextSibling() {
		if offset, found := firstOffset(child); found {
			return offset, true
		}
	}
	return 0, false
}

func render(markdown string, lineOffset int) map[string]any {
	// gh-gfm-preview normalizes line endings as it reads a file (app.Slurp)
	normalized, _, err := transform.String(new(crlf.Normalize), markdown)
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	app.ExtraParserOptions = []parser.Option{
		parser.WithASTTransformers(util.Prioritized(&sourceLines{offset: lineOffset}, 0)),
	}
	html, err := app.ToHTML(normalized, false)
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	return map[string]any{"html": html}
}

func main() {
	js.Global().Set("markonGfmRender", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) < 2 {
			return map[string]any{"error": "markonGfmRender(markdown, lineOffset)"}
		}
		return render(args[0].String(), args[1].Int())
	}))
	// Keep the runtime alive for later calls
	select {}
}
