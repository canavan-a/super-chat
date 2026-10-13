package main

import (
	"fmt"
	"math"
	"strings"
)

// The launcher icon is a smooth vector bubble rather than the pixel art: at
// launcher size the pixel steps read as jagged, not as style. It keeps the
// art's colors (outline tone 'A', fill tone '1', dots 'o') and roughly its
// shape: a rounded body whose lower-left corner sweeps out into the tail.
//
// Coordinates are in the 108dp adaptive-icon canvas. Everything stays inside
// the 66dp safe circle so no launcher mask clips it.

const (
	bubbleL, bubbleR = 26.0, 82.0
	bubbleT, bubbleB = 31.0, 67.0
	bubbleRad        = 14.0
	bubbleStroke     = 4.5
	dotRad           = 3.2
	dotGap           = 11.0
)

var (
	toneOutline = legend['A']
	toneFill    = legend['1']
	toneDot     = legend['o']
)

type pt struct{ x, y float64 }

// seg is one piece of the outline: a line, a quarter-circle corner (center c,
// from angle a0 to a1, clockwise on screen), or a cubic Bézier.
type seg struct {
	kind   byte // 'L', 'A', 'C'
	to     pt
	c      pt
	a0, a1 float64
	c1, c2 pt
}

func bubbleStart() pt { return pt{bubbleL + bubbleRad, bubbleT} }

func bubbleSegs() []seg {
	L, R, T, B, r := bubbleL, bubbleR, bubbleT, bubbleB, bubbleRad
	arc := func(cx, cy, a0, a1 float64) seg {
		return seg{kind: 'A', c: pt{cx, cy}, a0: a0, a1: a1,
			to: pt{cx + r*math.Cos(a1), cy + r*math.Sin(a1)}}
	}
	tip := pt{34, 77}
	return []seg{
		{kind: 'L', to: pt{R - r, T}},
		arc(R-r, T+r, -math.Pi/2, 0),
		{kind: 'L', to: pt{R, B - r}},
		arc(R-r, B-r, 0, math.Pi/2),
		{kind: 'L', to: pt{50, B}},
		// Out along the bottom into the tail's tip…
		{kind: 'C', c1: pt{45, B}, c2: pt{40, 72}, to: tip},
		// …and back up into the left side, replacing the lower-left corner.
		{kind: 'C', c1: pt{32, 73}, c2: pt{L, 68}, to: pt{L, 58}},
		{kind: 'L', to: pt{L, T + r}},
		arc(L+r, T+r, math.Pi, 3*math.Pi/2),
	}
}

func bubbleDots() []pt {
	cy := (bubbleT + bubbleB) / 2
	cx := (bubbleL + bubbleR) / 2
	return []pt{{cx - dotGap, cy}, {cx, cy}, {cx + dotGap, cy}}
}

// xform maps canvas coordinates into another viewport (scale s, then offset).
type xform struct{ s, dx, dy float64 }

func (t xform) p(q pt) string { return num(q.x*t.s+t.dx) + "," + num(q.y*t.s+t.dy) }

func bubblePath(t xform) string {
	var b strings.Builder
	b.WriteString("M" + t.p(bubbleStart()))
	for _, s := range bubbleSegs() {
		switch s.kind {
		case 'L':
			b.WriteString("L" + t.p(s.to))
		case 'A':
			r := num(bubbleRad * t.s)
			b.WriteString(fmt.Sprintf("A%s,%s 0 0,1 %s", r, r, t.p(s.to)))
		case 'C':
			b.WriteString("C" + t.p(s.c1) + " " + t.p(s.c2) + " " + t.p(s.to))
		}
	}
	return b.String() + "Z"
}

func dotsPath(t xform) string {
	var b strings.Builder
	r := dotRad * t.s
	for _, d := range bubbleDots() {
		x, y := d.x*t.s+t.dx, d.y*t.s+t.dy
		b.WriteString(fmt.Sprintf("M%s,%sa%s,%s 0 1,0 %s,0a%s,%s 0 1,0 -%s,0z",
			num(x-r), num(y), num(r), num(r), num(2*r), num(r), num(r), num(2*r)))
	}
	return b.String()
}

// bubbleVector is the foreground layer: filled, outlined bubble plus dots.
// fill/outline/dots are colors; an empty fill leaves the body hollow (the
// single-color versions).
func bubbleVector(t xform, fill, outline, dots string) string {
	fillAttr := `android:fillColor="` + fill + `"`
	if fill == "" {
		fillAttr = `android:fillColor="#00000000"`
	}
	return fmt.Sprintf(`    <path %s
        android:strokeColor="%s"
        android:strokeWidth="%s"
        android:strokeLineJoin="round"
        android:pathData="%s" />
    <path android:fillColor="%s" android:pathData="%s" />
`, fillAttr, outline, num(bubbleStroke*t.s), bubblePath(t), dots, dotsPath(t))
}

// ---- rasterizing (legacy PNGs and previews) ----

// bubblePoly flattens the outline into a closed polygon.
func bubblePoly() []pt {
	poly := []pt{bubbleStart()}
	for _, s := range bubbleSegs() {
		from := poly[len(poly)-1]
		switch s.kind {
		case 'L':
			poly = append(poly, s.to)
		case 'A':
			for i := 1; i <= 24; i++ {
				a := s.a0 + (s.a1-s.a0)*float64(i)/24
				poly = append(poly, pt{s.c.x + bubbleRad*math.Cos(a), s.c.y + bubbleRad*math.Sin(a)})
			}
		case 'C':
			for i := 1; i <= 32; i++ {
				u := float64(i) / 32
				v := 1 - u
				poly = append(poly, pt{
					v*v*v*from.x + 3*v*v*u*s.c1.x + 3*v*u*u*s.c2.x + u*u*u*s.to.x,
					v*v*v*from.y + 3*v*v*u*s.c1.y + 3*v*u*u*s.c2.y + u*u*u*s.to.y,
				})
			}
		}
	}
	return poly
}

// bubbleTone says which tone covers canvas point q, or false for background.
func bubbleTone(poly []pt, q pt) (Tone, bool) {
	for _, d := range bubbleDots() {
		if math.Hypot(q.x-d.x, q.y-d.y) <= dotRad {
			return toneDot, true
		}
	}
	inside := false
	dist := math.Inf(1)
	for i := range poly {
		a, b := poly[i], poly[(i+1)%len(poly)]
		if (a.y > q.y) != (b.y > q.y) && q.x < a.x+(q.y-a.y)*(b.x-a.x)/(b.y-a.y) {
			inside = !inside
		}
		dist = math.Min(dist, segDist(q, a, b))
	}
	switch {
	case dist <= bubbleStroke/2:
		return toneOutline, true
	case inside:
		return toneFill, true
	}
	return Tone{}, false
}

func segDist(q, a, b pt) float64 {
	dx, dy := b.x-a.x, b.y-a.y
	l := dx*dx + dy*dy
	t := 0.0
	if l > 0 {
		t = math.Max(0, math.Min(1, ((q.x-a.x)*dx+(q.y-a.y)*dy)/l))
	}
	return math.Hypot(q.x-(a.x+t*dx), q.y-(a.y+t*dy))
}
