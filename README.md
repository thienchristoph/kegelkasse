# Kegelkasse KC Red Snapper

Web-App zur Abrechnung von Strafen und Kegelbeiträgen. Läuft im Browser auf Apple und Android, auch offline an der Kegelbahn.

- **App:** https://thienchristoph.github.io/kegelkasse/
- **Daten:** Firebase Firestore (Projekt `kegelkasse-red-snapper`, Standort Frankfurt)
- **Zugang:** Rolle + PIN (Schriftführer, Präsident, Kassierer, Admin)

## Entwicklung

```
npm install
npx esbuild src/app.js --bundle --minify --format=iife --target=es2019 --outfile=app.js
```

`app.js` ist das gebaute Bundle und wird mit eingecheckt, damit GitHub Pages es direkt ausliefert.
Sicherheitsregeln: `firestore.rules` (in der Firebase-Konsole unter Firestore → Regeln einspielen).
