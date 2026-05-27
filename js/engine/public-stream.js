// Public Data Stream — maximally public, non-entropic data sources
// used as the "medium" that identity seeds project through.
//
// These sources are deterministic and globally observable:
//   - UTC time decomposed at multiple scales (ms, s, min, hr, day, year)
//   - Unix epoch components
//   - Astronomical: Julian date, lunar phase, solar declination
//   - Mathematical: digits of pi, e, sqrt(2) at time-indexed positions
//   - Bitcoin block height (polled)
//
// The public stream is the "canvas" — the identity seeds determine
// WHERE in the projection space you look at it.

const PI_DIGITS = '31415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679821480865132823066470938446095505822317253594081284811174502841027019385211055596446229489549303819644288109756659334461284756482337867831652712019091456485669234603486104543266482133936072602491412737245870066063155881748815209209628292540917153643678925903600113305305488204665213841469519415116094330572703657595919530921861173819326117931051185480744623799627495673518857527248912279381830119491298336733624406566430860213949463952247371907021798609437027705392171762931767523846748184676694051320005681271452635608277857713427577896091736371787214684409012249534301465495853710507922796892589235420199561121290219608640344181598136297747713099605187072113499999983729780499510597317328160963185950244594553469083026425223082533446850352619311881710100031378387528865875332083814206171776691473035982534904287554687311595628638823537875937519577818577805321712268066130019278766111959092164201989';

const E_DIGITS = '27182818284590452353602874713526624977572470936999595749669676277240766303535475945713821785251664274274663919320030599218174135966290435729003342952605956307381323286279434907632338298807531952510190115738341879307021540891499348841675092447614606680822648001684774118537423454424371075390777449920695517027618386062613313845830007520449338265602976067371132007093287091274437470472306969772093101416928368190255151086574637721112523897844250569536967707854499699679468644549059879316368892300987931277361782154249992295763514822082698951936680331825288693984964651058209392398294887933203625094431173012381970684161403970198376793206832823764648042953118023287825098194558153017567173613320698112509961818815930416903515988885193458072738667385894228792284998920868058257492796104841984443634632449684875602336248270419786232090021609902353043699418491463140934317381436405462531520961836908887070167683964243781405927145635490613031072085103837505101157477041718986106873969655212671546889570350354';

export class PublicDataStream {
  constructor() {
    this._blockHeight = 0;
    this._blockHeightTimestamp = 0;
    this._pollInterval = null;
  }

  start() {
    this._fetchBlockHeight();
    this._pollInterval = setInterval(() => this._fetchBlockHeight(), 30000);
  }

  stop() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  async _fetchBlockHeight() {
    try {
      const r = await fetch('https://blockchain.info/q/getblockcount');
      this._blockHeight = parseInt(await r.text()) || 0;
      this._blockHeightTimestamp = Date.now();
    } catch (e) {}
  }

  // Get the full public state vector at a given time
  // Returns an array of floats in [0,1] — each dimension is a different
  // public data decomposition
  sample(timeMs) {
    const t = timeMs || Date.now();
    const d = new Date(t);

    // Time decomposition at multiple scales
    const ms = (t % 1000) / 1000;
    const sec = d.getSeconds() / 60;
    const min = d.getMinutes() / 60;
    const hour = d.getHours() / 24;
    const dayOfYear = this._dayOfYear(d) / 366;
    const yearFrac = (d.getFullYear() % 100) / 100;
    const weekday = d.getDay() / 7;
    const monthFrac = d.getDate() / 31;

    // Julian date (astronomical time reference)
    const jd = this._julianDate(d);
    const jdFrac = jd % 1;

    // Lunar phase (synodic month ≈ 29.53059 days)
    const lunarCycle = 29.53059;
    const knownNewMoon = 2451550.1; // Jan 6, 2000 (Julian date)
    const lunarAge = ((jd - knownNewMoon) % lunarCycle + lunarCycle) % lunarCycle;
    const lunarPhase = lunarAge / lunarCycle;

    // Solar declination (approximate)
    const dayAngle = 2 * Math.PI * (this._dayOfYear(d) - 1) / 365;
    const solarDec = 0.006918 - 0.399912 * Math.cos(dayAngle) +
      0.070257 * Math.sin(dayAngle) - 0.006758 * Math.cos(2 * dayAngle) +
      0.000907 * Math.sin(2 * dayAngle);
    const solarNorm = (solarDec + 0.41) / 0.82; // normalize to ~[0,1]

    // Mathematical constants at time-indexed positions
    const piIdx = Math.floor(t / 100) % (PI_DIGITS.length - 4);
    const piVal = parseInt(PI_DIGITS.slice(piIdx, piIdx + 4)) / 10000;
    const eIdx = Math.floor(t / 137) % (E_DIGITS.length - 4);
    const eVal = parseInt(E_DIGITS.slice(eIdx, eIdx + 4)) / 10000;

    // Irrational number sequences
    const sqrt2Frac = (Math.SQRT2 * (t % 100000)) % 1;
    const phiFrac = ((1 + Math.sqrt(5)) / 2 * (t % 100000)) % 1;

    // Block height (discrete public consensus)
    const blockFrac = (this._blockHeight % 10000) / 10000;

    // Unix epoch decompositions
    const epoch10s = ((t / 10000) % 1);
    const epoch100s = ((t / 100000) % 1);
    const epochHour = ((t / 3600000) % 1);

    return new Float32Array([
      ms, sec, min, hour, dayOfYear, yearFrac, weekday, monthFrac,
      jdFrac, lunarPhase, solarNorm,
      piVal, eVal, sqrt2Frac, phiFrac,
      blockFrac,
      epoch10s, epoch100s, epochHour,
    ]);
  }

  // Number of dimensions in the public vector
  get dimensions() { return 19; }

  _dayOfYear(d) {
    const start = new Date(d.getFullYear(), 0, 0);
    return Math.floor((d - start) / 86400000);
  }

  _julianDate(d) {
    return (d.getTime() / 86400000) + 2440587.5;
  }
}
