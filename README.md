# ⚡ Wizard Duel v3 — Con Persistencia SQLite

Los perfiles, XP, niveles y estadísticas se guardan permanentemente en una
base de datos SQLite local (`data/wizard.db`). Reiniciar el servidor **no
borra ningún progreso**.

## Sistema de Progresión

### Niveles
| Nivel | Nombre    | XP requerida | Segundos contraataque |
|-------|-----------|--------------|-----------------------|
| 1     | Novato    | 0 XP         | 2.0 s                 |
| 2     | Aprendiz  | 100 XP       | 2.5 s                 |
| 3     | Iniciado  | 300 XP       | 3.0 s                 |
| 4     | Experto   | 700 XP       | 3.5 s                 |
| 5     | Maestro   | 1 500 XP     | 4.5 s                 |

### XP por evento
| Evento                  | XP  |
|-------------------------|-----|
| Victoria                | +50 |
| Derrota (participación) | +10 |
| Contraataque exitoso    | +8  |
| Contraataque fallido    | -2  |
| Combo                   | +5  |
| Racha × 3               | +25 |
| Racha × 5               | +60 |
| Reacción < 1.2 s        | +10 |
| Reacción < 2.0 s        | +4  |

## Estructura
```
wizard-duel-v3/
├── server.js        ← Node.js + Socket.io + SQLite
├── package.json
├── public/
│   └── index.html   ← frontend completo
├── data/            ← creado automáticamente al iniciar
│   └── wizard.db    ← base de datos SQLite (persistente)
└── README.md
```

## Deploy en Railway (~3 minutos)

```bash
npm install -g @railway/cli
railway login
railway init          # "Empty project"
railway up
railway domain        # genera tu URL pública
```

Railway monta un volumen persistente automáticamente.
Para garantizar que `data/wizard.db` sobrevive redeploys, agrega en
Railway → Settings → Variables:
```
DB_PATH=/data/wizard.db
```
Y en Railway → Settings → Volumes: monta `/data`.

## Desarrollo local

```bash
npm install
npm run dev
# Abre http://localhost:3000
# La DB se crea en ./data/wizard.db automáticamente
```

## Notas
- El reconocimiento de voz requiere HTTPS (Railway lo da automáticamente)
- Funciona en Chrome y Edge; Safari tiene soporte parcial
- La DB puede inspeccionarse con cualquier cliente SQLite (DB Browser, TablePlus)
