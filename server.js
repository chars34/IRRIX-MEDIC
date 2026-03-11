```javascript
const cors = require("cors");
const fs = require("fs");
const csv = require("csv-parser");
const path = require("path");
const express = require("express");

const app = express();

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

let poblacionData = {};
let equipamientoData = {};
let nombreMunicipios = {};
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

/* ===== ITER ===== */

fs.createReadStream(iterPath)
.pipe(csv({ mapHeaders: ({ header }) => header.replace(/^\uFEFF/, "").trim() }))
.on("data", (row) => {

    const entidad = row["ENTIDAD"]?.padStart(2,"0");
    const municipio = row["MUN"]?.padStart(3,"0");
    const loc = row["LOC"]?.padStart(4,"0");
    const poblacion = parseInt(row["POBTOT"]) || 0;
    const nombre = row["NOM_MUN"];

    if(entidad==="21" && municipio!=="000" && loc==="0000"){

        const clave = entidad + municipio;

        poblacionData[clave] = poblacion;
        nombreMunicipios[clave] = nombre;
        clavePorNombre[nombre.toLowerCase()] = clave;

    }

})
.on("end",()=>{
    console.log("✔ ITER cargado");
    archivoListo();
});

/* ===== DENUE ===== */

fs.createReadStream(denuePath)
.pipe(csv())
.on("data",(row)=>{

    const clee = row.clee;

    if(clee && clee.startsWith("21")){

        const clave = clee.substring(0,5);

        equipamientoData[clave] =
        (equipamientoData[clave] || 0) + 1;

    }

})
.on("end",()=>{
    console.log("✔ DENUE cargado");
    archivoListo();
});

/* ================================
   ENDPOINT NEGOCIOS
================================ */

app.get("/api/negocios",(req,res)=>{

    const tipo = req.query.tipo;
    const resultados = [];

    fs.createReadStream(denuePath)
    .pipe(csv())
    .on("data",(row)=>{

        const lat = parseFloat(row.latitud);
        const lon = parseFloat(row.longitud);
        const nombre = row.nom_estab;
        const codigo = row.codigo_act || "";

        if(!lat || !lon) return;

        let categoria=null;

        if(codigo.startsWith("722")) categoria="restaurante";
        if(codigo.startsWith("71394")) categoria="gimnasio";
        if(codigo.startsWith("621")) categoria="hospital";
        if(codigo.startsWith("46411")) categoria="farmacia";
        if(codigo.startsWith("462")) categoria="supermercado";

        if(tipo && categoria!==tipo) return;

        if(categoria){

            resultados.push({
                nombre,
                categoria,
                lat,
                lng:lon
            });

        }

    })
    .on("end",()=>{

        res.json(resultados.slice(0,2000));

    });

});

/* ================================
   IARM MUNICIPAL
================================ */

app.get("/api/iarm/:claveGeo",(req,res)=>{

    if(!datosListos){
        return res.status(503).json({error:"Datos cargando"});
    }

    const clave = req.params.claveGeo;

    if(!(clave in poblacionData)){
        return res.status(404).json({error:"Municipio no encontrado"});
    }

    const poblacion = poblacionData[clave];
    const equipamiento = equipamientoData[clave] || 0;

    const densNorm = normalizar(poblacion,minP,maxP);
    const equipNorm = normalizar(equipamiento,minE,maxE);

    const iarm = (densNorm + (1-equipNorm))/2;

    res.json({

        clave,
        municipio:nombreMunicipios[clave],
        poblacion,
        equipamiento,
        iarm

    });

});

/* ================================
   IRMA PERSONAL
================================ */

app.get("/api/irma",(req,res)=>{

    const {municipio,glucosa,imc,cintura,actividad} = req.query;

    if(!municipio || !glucosa || !imc || !cintura || !actividad){
        return res.status(400).json({error:"Faltan datos"});
    }

    function norm(x,a,b){
        return (x-a)/(b-a);
    }

    const G = norm(glucosa,70,180);
    const IMC = norm(imc,18,40);
    const C = norm(cintura,70,130);
    const AF = norm(actividad,0,7);

    const M = (G + IMC + C + (1-AF))/4;

    let clave = municipio;

    if(!/^\d{5}$/.test(municipio)){
        clave = clavePorNombre[municipio.toLowerCase()];
    }

    if(!clave){
        return res.status(404).json({error:"Municipio no encontrado"});
    }

    const poblacion = poblacionData[clave];
    const equipamiento = equipamientoData[clave] || 0;

    const densNorm = normalizar(poblacion,minP,maxP);
    const equipNorm = normalizar(equipamiento,minE,maxE);

    const A = (densNorm + equipNorm)/2;

    const IRMA = (0.6*M) + (0.4*A);

    let riesgo="Bajo";

    if(IRMA>0.6) riesgo="Alto";
    else if(IRMA>0.3) riesgo="Moderado";

    res.json({

        municipio:nombreMunicipios[clave],
        indice_metabolico:M,
        indice_urbano:A,
        irma:IRMA,
        nivel:riesgo

    });

});

/* ================================
   MUNICIPIOS
================================ */

app.get("/api/municipios",(req,res)=>{

    res.json(Object.values(nombreMunicipios));

});

/* ================================
   RANKING
================================ */

app.get("/api/ranking",(req,res)=>{

    if(!datosListos) return res.json([]);

    const ranking = Object.keys(poblacionData).map(clave=>{

        const p = poblacionData[clave];
        const e = equipamientoData[clave] || 0;

        const pNorm = normalizar(p,minP,maxP);
        const eNorm = normalizar(e,minE,maxE);

        const iarri = (0.6*pNorm) + (0.4*eNorm);

        return{

            municipio:nombreMunicipios[clave],
            iarri:Number(iarri.toFixed(4))

        };

    });

    ranking.sort((a,b)=>b.iarri-a.iarri);

    res.json(ranking);

});

/* ================================
   INICIAR SERVIDOR
================================ */

const PORT = process.env.PORT || 3000;

app.listen(PORT,()=>{

    console.log(`🚀 Servidor ejecutándose en http://localhost:${PORT}`);

});
```
