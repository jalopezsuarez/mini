-- Choreography for the 20s promo of `mini`.
-- Total budget: ~19s of action + 1s tail. Tweak `cps` to adjust typing speed.

property cps : 0.05 -- seconds per character (0.05 = ~20 chars/s, fast but readable)

on typeText(t)
	repeat with i from 1 to (count of characters of t)
		tell application "System Events" to keystroke (character i of t)
		delay cps
	end repeat
end typeText

on pressReturn()
	tell application "System Events" to keystroke return
	delay 0.08
end pressReturn

-- Bring mini to front
tell application "mini" to activate
delay 1.2

tell application "System Events"
	-- [0.0–1.5s] empty canvas, cursor blinks
	delay 0.3

	-- [1.5–4.5s] title + intro line
	my typeText("# mini")
	my pressReturn()
	my pressReturn()
	my typeText("A minimalist Markdown editor.")
	my pressReturn()
	my pressReturn()
	delay 0.4

	-- [4.5–7.5s] features header + bullet list (manual dashes, predictable)
	my typeText("## Features")
	my pressReturn()
	my pressReturn()
	my typeText("- Distraction-free writing")
	my pressReturn()
	my typeText("- Live preview")
	my pressReturn()
	my typeText("- Numbered headers")
	delay 0.6

	-- [~12.5s] WOW #1: auto-number all headers
	keystroke "h" using {command down, shift down}
	delay 1.4

	-- [~14s] WOW #2: switch to rendered view
	keystroke "m" using command down
	delay 5.0 -- hold the rendered frame so the viewer can read it
end tell
