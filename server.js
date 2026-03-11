
const cors = require("cors");
const fs = require("fs");
const csv = require("csv-parser");
const path = require("path");
const express = require("express")
const app = express()

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));


// PERMITE SERVIR ARCHIVOS DE LA CARPETA PUBLIC
app.use(express.static("public"))

app.listen(3000, () => {
  console.log("Servidor corriendo en http://localhost:3000")
})
let poblacionData = {};
let equipamientoData = {};
let nombreMunicipios = {};     // ← AGREGAR
let municipioPorNombre = {};
let clavePorNombre = {};

let minP, maxP, minE, maxE;
let archivosCargados = 0;
let datosListos = false;

/* ================================
   FUNCIONES AUXILIARES
================================ */

function normalizar(valor, min, max) {
    if (max === min) return 0;
    return (valor - min) / (max - min);
}

function recalcularExtremos() {
    const poblaciones = Object.values(poblacionData);
    const equipamientos = Object.values(equipamientoData);

    if (!poblaciones.length) {
        console.error("❌ No hay datos de población");
        process.exit(1);
    }

    minP = Math.min(...poblaciones);
    maxP = Math.max(...poblaciones);

    minE = equipamientos.length ? Math.min(...equipamientos) : 0;
    maxE = equipamientos.length ? Math.max(...equipamientos) : 1;
}

function archivoListo() {
    archivosCargados++;
    if (archivosCargados === 2) {
        recalcularExtremos();
        datosListos = true;
        console.log("🔥 Datos completamente listos para el cálculo IARM");
    }
}

/* ================================
   CARGA DE DATOS
================================ */

const iterPath = path.join(__dirname, "iter_puebla_2020.csv");
const denuePath = path.join(__dirname, "denue_puebla.csv");

if (!fs.existsSync(iterPath)) {
    console.error("❌ No se encontró iter_puebla_2020.csv");
    process.exit(1);
}

if (!fs.existsSync(denuePath)) {
    console.error("❌ No se encontró denue_puebla.csv");
    process.exit(1);
}

/* ===== ITER (POBLACIÓN + NOMBRE) ===== */
fs.createReadStream(iterPath)
    .pipe(csv({ mapHeaders: ({ header }) => header.replace(/^\uFEFF/, "").trim() }))
    .on("data", (row) => {
        try {
            const entidad = row["ENTIDAD"]?.padStart(2, "0");
            const municipio = row["MUN"]?.padStart(3, "0");
            const loc = row["LOC"]?.padStart(4, "0");
            const poblacion = parseInt(row["POBTOT"]) || 0;
            const nombre = row["NOM_MUN"];

            if (entidad === "21" && municipio !== "000" && loc === "0000") {
                const clave = entidad + municipio;
                poblacionData[clave] = poblacion;
nombreMunicipios[clave] = nombre;
clavePorNombre[nombre.toLowerCase()] = clave;
            }
        } catch (err) {
            console.error("Error procesando fila ITER:", err);
        }
    })
    .on("end", () => {
        console.log("✔ ITER cargado correctamente");
        archivoListo();
    })
    .on("error", (err) => {
        console.error("❌ Error leyendo ITER:", err);
        process.exit(1);
    });

/* ===== DENUE (EQUIPAMIENTO) ===== */
fs.createReadStream(denuePath)
    .pipe(csv())
    .on("data", (row) => {
        try {
            const clee = row["clee"];
            if (clee && clee.startsWith("21")) {
                const claveMunicipal = clee.substring(0, 5);
                equipamientoData[claveMunicipal] =
                    (equipamientoData[claveMunicipal] || 0) + 1;
            }
        } catch (err) {
            console.error("Error procesando fila DENUE:", err);
        }
    })
    .on("end", () => {
        console.log("✔ DENUE cargado correctamente");
        archivoListo();
    })
    .on("error", (err) => {
        console.error("❌ Error leyendo DENUE:", err);
        process.exit(1);
    });

/* ================================
   ENDPOINTS
================================ */
app.get("/api/negocios", (req, res) => {

    const tipo = req.query.tipo
    const resultados = []

    fs.createReadStream("denue_puebla.csv")
    .pipe(csv())
    .on("data", (row) => {

        const lat = parseFloat(row.latitud)
        const lon = parseFloat(row.longitud)
        const nombre = row.nom_estab
        const codigo = row.codigo_act || ""

        if(!lat || !lon) return

        let categoria = null

        if(codigo.startsWith("722")) categoria = "restaurante"
        if(codigo.startsWith("71394")) categoria = "gimnasio"
        if(codigo.startsWith("621")) categoria = "hospital"
        if(codigo.startsWith("46411")) categoria = "farmacia"
        if(codigo.startsWith("462")) categoria = "supermercado"

        if(tipo && categoria !== tipo) return

        if(categoria){
            resultados.push({
                nombre,
                categoria,
                lat,
                lon
            })
        }

    })
    .on("end", () => {

        res.json(resultados.slice(0,2000))

    })

})
/* ===== IARM INDIVIDUAL ===== */
app.get("/api/iarm/:claveGeo", (req, res) => {

    if (!datosListos) {
        return res.status(503).json({
            error: "Los datos aún se están cargando en el servidor."
        });
    }

    const clave = req.params.claveGeo;

    // Validación formato
    if (!/^\d{5}$/.test(clave)) {
        return res.status(400).json({
            error: "Formato de clave inválido. Debe ser 5 dígitos."
        });
    }

    if (!(clave in poblacionData)) {
        return res.status(404).json({
            error: "Municipio no encontrado."
        });
    }

    const poblacion = poblacionData[clave];
    const equipamiento = equipamientoData[clave] || 0;

    const densidadNorm = normalizar(poblacion, minP, maxP);
    const equipamientoNorm = normalizar(equipamiento, minE, maxE);

    const iarm = (densidadNorm + (1 - equipamientoNorm)) / 2;

    const nivel =
        iarm < 0.25 ? "Bajo" :
        iarm < 0.5 ? "Medio" :
        iarm < 0.75 ? "Alto" : "Crítico";

    res.json({
        clave,
        nombre: nombreMunicipios[clave],
        poblacion,
        equipamiento,
        iarm,
        nivel
    });
});
/* ===== CALCULAR IRMA ===== */

app.get("/api/irma", (req, res) => {

    const {
        municipio,
        glucosa,
        imc,
        cintura,
        actividad
    } = req.query;

    if (!municipio || !glucosa || !imc || !cintura || !actividad) {
        return res.status(400).json({
            error: "Faltan parámetros"
        });
    }

    // -------- NORMALIZACIÓN METABÓLICA --------

    function norm(x, xmin, xmax){
        return (x - xmin) / (xmax - xmin);
    }

    const G = norm(parseFloat(glucosa),70,180);
    const IMC = norm(parseFloat(imc),18,40);
    const C = norm(parseFloat(cintura),70,130);
    const AF = norm(parseFloat(actividad),0,7);

    const M = (G + IMC + C + (1 - AF)) / 4;

    // -------- ÍNDICE URBANO (simplificado usando equipamiento) --------

 let clave = municipio;

// si no es clave numérica buscar por nombre
if(!/^\d{5}$/.test(municipio)){
    clave = clavePorNombre[municipio.toLowerCase()];
}


  if(!clave || !(clave in poblacionData)){
    return res.status(404).json({
        error:"Municipio no encontrado"
    });
}

    const poblacion = poblacionData[clave];
    const equipamiento = equipamientoData[clave] || 0;

    const densNorm = normalizar(poblacion,minP,maxP);
    const equipNorm = normalizar(equipamiento,minE,maxE);

    const A = (densNorm + equipNorm)/2;

    // -------- IRMA --------

    const IRMA = (0.6 * M) + (0.4 * A);

    let riesgo;

    if(IRMA < 0.3) riesgo = "Bajo";
    else if(IRMA < 0.6) riesgo = "Moderado";
    else riesgo = "Alto";

    res.json({
        municipio: nombreMunicipios[clave],
        indice_metabolico: M,
        indice_urbano: A,
        irma: IRMA,
        nivel: riesgo
    });

});
app.get("/api/municipios",(req,res)=>{
    res.json(Object.values(nombreMunicipios));
});
/* ===== RANKING COMPLETO ===== */
app.get("/api/ranking", (req, res) => {

    if (!datosListos) {
        return res.json([]);
    }

    const ranking = Object.keys(poblacionData).map(clave => {

        const poblacion = poblacionData[clave] || 0;
        const equipamiento = equipamientoData[clave] || 0;

        const pNorm = normalizar(poblacion, minP, maxP);
        const eNorm = normalizar(equipamiento, minE, maxE);

        const IARRI = (0.6 * pNorm) + (0.4 * eNorm);

        return {
            municipio: nombreMunicipios[clave] || clave,
            iarri: Number(IARRI.toFixed(4))
        };
    });

    ranking.sort((a,b)=>b.iarri-a.iarri);

    res.json(ranking);
});

/* ================================
   INICIO SERVIDOR
================================ */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 Servidor IARM ejecutándose en http://localhost:${PORT}`);
});