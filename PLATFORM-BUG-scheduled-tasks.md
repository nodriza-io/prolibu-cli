# Bug de plataforma: `scheduledTask` no se ejecuta

**Fecha del informe:** 2026-08-11
**Severidad:** alta — automatizaciones programadas silenciosamente muertas, sin error ni log
**Cuentas confirmadas:** `oxohotel.prolibu.com` · indicios en `suite.prolibu.com`

---

## 1. Resumen

El ejecutor de tareas programadas dejó de disparar. Un script con `active: true` y una
`scheduledTask.periodicity` válida **no se ejecuta nunca**, y no deja ningún rastro: ni entrada de
log, ni error, ni ejecución fallida. Desde fuera es indistinguible de que la tarea no existiera.

El caso testigo es `daily-report` en `oxohotel.prolibu.com`, que llevaba meses ejecutándose a
diario **a las 23:00:00 UTC con precisión de segundos** y se detuvo en seco.

**Lo relevante para diagnóstico:** con `periodicity: "* * * * *"` (cada minuto), activo y
observado **9 minutos seguidos**, hubo **cero ejecuciones**. Debería haber disparado 9 veces.

---

## 2. Impacto

- 25 gerentes de hotel dejaron de recibir su reporte diario de pipeline. Nadie se enteró: no hay
  alerta, log ni error asociados a una tarea que no dispara.
- El fallo es **silencioso por diseño actual**: el objeto `Script` no expone ningún estado de
  registro (`nextRun`, `lastRun`, `jobId`, `registeredAt`), así que **desde la API es imposible
  saber si una tarea está registrada**. La única forma de comprobarlo es esperar a que dispare.

---

## 3. Cronología

| Momento (UTC) | Hecho |
|---|---|
| … → **2026-08-09 23:00:00** | El cron dispara **todos los días**, puntual. 25 correos por corrida, entre `23:00:00` y `23:00:33`. Verificable en `/v2/email` filtrando `emailCode` que empiece por `daily-report-`. |
| 2026-08-10 19:59 | Se despliega código nuevo al script (`PATCH /v2/script/daily-report` con `code`, `variables`, `readme`). **Sospecha inicial, luego descartada** — ver §5. |
| **2026-08-10 23:00** | **No se ejecuta.** Sin logs, sin correos, sin error. |
| **2026-08-11 23:00** | Tampoco (a fecha del informe, ya con 5 experimentos fallidos por medio). |

---

## 4. Evidencia: 5 experimentos controlados, 0 ejecuciones

Todos con `active: true`, `timeZone: "America/Bogota"`, `timeout: 300000` y una `periodicity`
sintácticamente válida y verificada tras el `PATCH` releyendo el documento.

| # | Script | `periodicity` | Debía disparar (UTC) | Observado | Resultado |
|---|---|---|---|---|---|
| 1 | `daily-report-dev` | `52 13 * * *` | 2026-08-10 18:52 | 6 min | no disparó |
| 2 | `daily-report-dev` | `5 14 */1 * *` | 2026-08-10 19:05 | 10 min | no disparó |
| 3 | `daily-report-dev` | `43 9 */1 * *` | 2026-08-11 14:43 | 11 min | no disparó |
| 4 | `daily-report` (prod) | `51 10 */1 * *` | 2026-08-11 15:51 | 9 min | no disparó |
| 5 | **`daily-report` (prod)** | **`* * * * *`** | **cada minuto** | **9 min** | **no disparó (0 de ~9)** |

En el experimento 4 se forzó un **cambio real** de `active` (`false` → `true`) además de una
`periodicity` distinta a la anterior, para descartar que un `PATCH` con el mismo valor fuese un
no-op que no re-registrase la tarea.

**Cómo se observó cada ejecución** (tres señales independientes, ninguna apareció):

1. `GET /v2/log?logType=Script&sort=-createdAt` — el script escribe `console.info`/`console.error`.
2. `GET /v2/email?sort=-createdAt` — una corrida crea registros de Email.
3. La variable `last-run` del propio script, que se escribe con `setVariable` al terminar.

**La cuenta está sana durante todo el periodo:** la API responde con normalidad, se actualizaron
161 deals entre el 10-ago 20:00 y el 11-ago, y los correos enviados por otras vías se entregan
(`status: sent`). No es una caída general del backend.

### Segunda cuenta con indicios

`suite.prolibu.com`, script **`crm-dev`** (`_id` consultable), `periodicity: "0 */1 * * *"`
(cada hora), `active: true`, `updatedAt: 2026-07-30`. Sus variables incluyen
`send-report-to-email = juan.prieto@prolibu.com`, es decir, una corrida debería producir correo.

En `/v2/email` de esa cuenta **no hay ningún correo a esa dirección**; los más recientes son de
otros flujos y esporádicos (10-ago, 04-ago, 28-jul). Los únicos logs de Script de la cuenta son
fallos de *lifecycle hook* del 10-ago y del 07-ago, no de ejecuciones programadas.

> ⚠️ Este indicio es **sugerente, no concluyente**: no sabemos si `crm-dev` llegó a funcionar ni
> bajo qué condiciones envía. Pero un cron horario y activo que no deja ningún artefacto apunta a
> que el problema **no es específico de `oxohotel.prolibu.com`**. Conviene que lo confirméis
> mirando el estado del scheduler a nivel plataforma antes que cuenta por cuenta.

---

## 5. Qué queda descartado

- **No es el despliegue.** Fue la primera hipótesis por correlación temporal (deploy 19:59 → falla
  la corrida de las 23:00), pero los experimentos 3, 4 y 5 se hicieron **sin tocar el `code`** y
  tampoco dispararon.
- **No es un `PATCH` no-op.** El experimento 4 cambió `active` de verdad (`false` → `true`) y usó
  una `periodicity` nueva.
- **No es latencia de registro.** El experimento 5 (`* * * * *`, 9 minutos) lo descarta: cualquier
  ventana de recarga razonable habría producido al menos una ejecución.
- **No es la expresión cron.** Se usó el mismo formato de 5 campos que llevaba meses funcionando
  (`00 18 */1 * *`), y también la forma canónica `* * * * *`.
- **No es la zona horaria.** `America/Bogota` se venía aplicando correctamente: `00 18` disparaba a
  las 23:00 UTC, que es 18:00 en Bogotá.
- **No es el script.** No llega a ejecutarse: un fallo en tiempo de carga sí genera entrada de log
  con `status: Failure` (comprobado el 10-ago con un error real de `module.exports`), y aquí no hay
  ninguna. Además el script se ejecuta bien si se invoca por otras vías.
- **No es `timeout`.** Está en 300000 (el máximo permitido).

---

## 6. Lo que no pudimos comprobar (requiere acceso al servidor)

- Si el proceso/worker del scheduler está vivo, y desde cuándo.
- Si las tareas se registran en algún almacén (BullMQ, agenda, tabla de jobs, cron interno) y si
  el registro de `daily-report` sigue ahí o se perdió.
- Si un `PATCH` sobre `code`/`variables` elimina el registro sin recrearlo. **Esta sigue siendo una
  hipótesis viva** aunque no explique por sí sola los experimentos 3-5: podría haber dos problemas
  distintos, uno que borró el registro original y otro que impide crear registros nuevos.
- Si el fallo es global o por cuenta/shard/tenant.

---

## 7. Datos del entorno

**Cuenta:** `oxohotel.prolibu.com`

```
Script  daily-report      _id 69b32af01d1da6eafdf4babe   active true   timeout 300000
        scheduledTask { periodicity: "00 18 */1 * *", timeZone: "America/Bogota" }
        lifecycleHooks []   runOnQuoteCalculate false   workspace 67dc83fe2793f5763328c0ee

Script  daily-report-dev  _id 69b32af05ed89794cbee8966   active false (restaurado tras pruebas)
```

Última ejecución programada correcta: **2026-08-09T23:00:00Z**.

---

## 8. Reproducción mínima

```
1. PATCH /v2/script/<code>  { "scheduledTask": { "periodicity": "* * * * *",
                                                 "timeZone": "America/Bogota" },
                              "active": true }
2. GET   /v2/script/<code>   -> confirmar que persistió periodicity y active
3. Esperar 5 minutos
4. GET   /v2/log?logType=Script&sort=-createdAt   -> sin entradas nuevas
   GET   /v2/email?sort=-createdAt                -> sin registros nuevos
   GET   /v2/script/<code>?select=variables       -> la variable `last-run` no aparece
```

Esperado: ~5 ejecuciones. Observado: 0.

---

## 9. Qué pedimos

1. **Confirmar el alcance**: ¿está caído el scheduler a nivel plataforma, o solo para ciertas
   cuentas/tenants? Los indicios de `suite.prolibu.com` sugieren que no es un caso aislado.
2. **Restaurar la ejecución** de las tareas ya registradas.
3. **Aclarar el ciclo de vida del registro**: ¿un `PATCH` de `code` o `variables` desregistra la
   tarea? Si es así, debería documentarse o —mejor— recrearse automáticamente en cada guardado.
   El CLI (`api/scriptClient.js`) solo hace `PATCH` de `variables`, `lifecycleHooks`, `readme`,
   `git` y `code`; nunca toca `scheduledTask`. Si desplegar rompe el cron, **todo despliegue de un
   script programado lo mata en silencio**, y eso afecta a cualquiera que use el CLI.

### Petición de producto, independiente del bug

Exponer **estado de programación** en el objeto `Script`: `nextRunAt`, `lastRunAt`,
`lastRunStatus`, `registered`. Hoy no hay forma de saber si una tarea está viva salvo esperar a
que dispare, y por eso este fallo pasó **dos días** desapercibido. Con un `nextRunAt` visible, un
monitor trivial lo habría detectado en minutos.

---

## 10. Cómo verificaremos que está arreglado

```
PATCH /v2/script/daily-report  { "scheduledTask": { "periodicity": "* * * * *",
                                                    "timeZone": "America/Bogota" } }
```

Si aparece la variable `last-run` en el script en menos de 2 minutos, funciona. Después se
restaura `00 18 */1 * *`.

Es inocuo hacerlo el mismo día: el script genera `emailCode` deterministas
(`daily-report-<workspaceId>-YYYYMMDD`), así que si el reporte del día ya salió, los envíos se
rechazan con `400 "emailCode ... ya existe"` y **no se duplica ningún correo**.

---

## ADDENDUM (2026-08-11 16:50 UTC) — respuesta al análisis de backend

Backend propone como causa raíz que el scheduler vive en un `Map` en memoria del pod líder y que
`registerScheduledTask()` retorna temprano si `!global.replicaLeader` (`Script.js:549`), de modo
que un `PATCH` que aterrice en el seguidor nunca llega al líder. **Corrigen con razón nuestra
hipótesis del §5**: el despliegue no desregistra nada.

Hemos medido lo que hacía falta para validar ese modelo. **No lo sostiene.**

### Hay 2 pods y el reparto es round-robin real, no sticky

`GET /prlversion`, 12 llamadas con `Connection: close`:

```
oxohotel-prolibu-com-app-8d996c8c5-gckmd   replicaLeader: true    uptime 11h59m   (6 de 12)
oxohotel-prolibu-com-app-8d996c8c5-t7nlr   replicaLeader: false   uptime 11h58m   (6 de 12)
```

Hay líder electo, y el balanceo es ~50/50 sin afinidad de sesión.

### El líder recibió los PATCH y aun así no disparó

Durante la investigación se hicieron **≥12 `PATCH` que llevaban `scheduledTask.periodicity` y/o
`active`**, repartidos en dos días y en conexiones independientes. Con reparto 50/50:

| Escenario | P(todos caen en el seguidor) |
|---|---|
| Los 5 experimentos del §4 | ~3 % |
| Los ≥12 PATCH con schedule | **~0,02 %** |

Es prácticamente seguro que **varios llegaron al líder**. Y el experimento 5 es el más
concluyente: si ese `PATCH` de `* * * * *` tocó al líder, debió disparar 9 veces en la ventana
observada.

Además, el líder `gckmd` **arrancó ~04:27 UTC del 11-ago**, es decir **antes** de los experimentos
3, 4 y 5 (14:43, 15:51 y 15:57 UTC). Tras ese arranque, `CronJobs.start() → loadScheduledTasks()`
debería haber re-registrado `daily-report` por sí solo. No lo hizo.

### Un líder recién arrancado tampoco registra (segunda cuenta)

En `suite.prolibu.com` el pod líder `g9n5x` arrancó ~15:51 UTC. El script `crm-dev`
(`0 */1 * * *`, `active: true`) debía disparar a las **16:00 UTC**. A las 16:46 no hay ninguna
entrada de log ni artefacto de esa ejecución.

> ⚠️ Caveat honesto: no sabemos si `crm-dev` produce artefactos observables en cada corrida —
> podría loguear solo en error y enviar solo bajo ciertas condiciones. Tomadlo como indicio, no
> como prueba. La evidencia dura es la de `oxohotel`.

### Conclusión y consecuencias para el plan

La brecha multi-réplica es real y merece arreglarse, pero **no explica los datos**. Hay un segundo
fallo, no identificado, **en el propio líder**: no ejecuta tareas programadas ni las registradas al
boot ni las que le llegan por `PATCH` directo.

Tres implicaciones sobre el plan propuesto:

1. **El reconciliador también está detrás del guard de líder y llama al mismo
   `registerScheduledTask()`.** Si lo que está roto es esa función —o el subsistema de crons del
   líder: latch `isRunning` (defecto 3), `loadScheduledTasks()` fallando en silencio (defecto 2)—
   el reconciliador **hereda el bug** y converge a un estado que igualmente no dispara. Antes de
   construirlo conviene reproducir **en el líder**, no solo la ruta del seguidor.
2. **La mitigación de reiniciar el pod líder no funciona.** El líder de oxohotel ya reinició hoy
   (04:27 UTC) y el de suite hace ~1 h; ninguno recuperó sus crons. Refuerza que el problema está
   en el camino de arranque (defectos 2 y 3), no en la propagación.
3. **Falta política de misfire.** El reconciliador hace converger el registro, pero no recupera la
   ejecución perdida: si `daily-report` se registra a las 18:00:30, su próxima ocurrencia es
   mañana. Para un reporte diario de negocio, "converge" y "el reporte salió" no son lo mismo —
   es exactamente lo que nos ha costado dos días.

### Qué pedimos ahora, en este orden

1. Mirar el estado del subsistema de crons **en el pod líder `gckmd`**: ¿`CronJobs.isRunning`?
   ¿cuántas entradas tiene el `Map` de tareas? ¿`loadScheduledTasks()` lanzó al arrancar?
   Eso debería dar el segundo fallo en minutos.
2. Con eso confirmado, el plan del reconciliador + pub/sub sigue siendo el arreglo correcto de
   fondo. Añadir política de misfire y una alerta de "sin líder / sin tareas registradas".

---

## Anexo: contexto del script (no forma parte del bug)

El `daily-report` se reescribió el 10-ago por motivos ajenos a esto: hacía 225 consultas por
corrida (9 etapas × 25 hoteles, en ráfagas de 9 concurrentes) y venía dando **502** desde el
gateway; ahora hace **1**. Ese trabajo está cerrado y verificado. Se menciona solo porque el
despliegue coincide en el tiempo con el inicio del fallo del scheduler y fue nuestra primera
sospecha, ya descartada (§5).
