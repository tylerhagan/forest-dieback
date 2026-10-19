"""Assemble a single page (inline CSS and JS) for publishing; data files stay alongside in data/."""
import re
from pathlib import Path
web = Path(__file__).parents[1] / "web"
html = (web / "index.html").read_text()
body = re.search(r"<!--app-->(.*)<!--/app-->", html, re.S).group(1)
fonts = re.search(r'<link rel="stylesheet" href="(https://fonts.googleapis.com[^"]+)">', html).group(1)
out = (
    '<title>Forest Change Explorer</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n'
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    f'<link rel="stylesheet" href="{fonts}">\n'
    f"<style>\n{(web / 'src/styles.css').read_text()}\n</style>\n{body}\n"
    f'<script type="module">\n{(web / "src/app.js").read_text()}\n</script>\n'
)
dist = Path(__file__).parents[1] / "dist"
dist.mkdir(exist_ok=True)
(dist / "forest-change.html").write_text(out)
print("wrote", dist / "forest-change.html", len(out))
