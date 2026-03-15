# 🏠 Comparador de Inmuebles

Herramienta interactiva para comparar propiedades en venta. Pega links de portales inmobiliarios (Wasi, FincaRaiz, Metrocuadrado, etc.) y los datos se extraen automáticamente con IA.

## 🚀 Deploy en Netlify (paso a paso)

### 1. Sube este repositorio a GitHub
```bash
git init
git add .
git commit -m "Comparador de inmuebles"
git remote add origin https://github.com/TU_USUARIO/comparador-inmuebles.git
git push -u origin main
```

### 2. Conecta con Netlify
1. Ve a [app.netlify.com](https://app.netlify.com)
2. Click en **"Add new site"** → **"Import an existing project"**
3. Selecciona **GitHub** y elige el repositorio `comparador-inmuebles`
4. Netlify detectará automáticamente la configuración del `netlify.toml`
5. Click en **"Deploy site"**

### 3. Configura la API Key de Claude (CRÍTICO)
1. En Netlify, ve a **Site settings** → **Environment variables**
2. Click **"Add a variable"**
3. Nombre: `ANTHROPIC_API_KEY`
4. Valor: Tu API key de Anthropic (empieza con `sk-ant-...`)
5. Click **"Save"**
6. Ve a **Deploys** → Click **"Trigger deploy"** → **"Deploy site"**

### 4. ¡Listo!
Tu comparador estará disponible en `https://tu-sitio.netlify.app`

## 📁 Estructura del proyecto
```
comparador-inmuebles/
├── public/
│   └── index.html           ← Frontend (comparador interactivo)
├── netlify/
│   └── functions/
│       └── scrape.js        ← Función serverless (lee inmuebles con Claude API)
├── netlify.toml              ← Configuración de Netlify
├── package.json              ← Dependencias
└── README.md
```

## 🔧 Cómo funciona
1. El usuario pega un link de un portal inmobiliario
2. Click en **🤖 Auto** → llama a `/.netlify/functions/scrape`
3. La función serverless usa la API de Claude con `web_search` para leer la página
4. Claude extrae los datos y los devuelve en JSON
5. El frontend llena la ficha automáticamente
6. El usuario puede editar cualquier campo y agregar datos adicionales
7. La tabla comparativa y el ranking se calculan en tiempo real

## 💰 Costos
- **Netlify Free Tier**: 125,000 invocaciones/mes de functions (gratis)
- **Claude API**: ~$0.003 por consulta con Sonnet (web_search incluido)
- Estimado: comparar 100 inmuebles/mes ≈ $0.30 USD
