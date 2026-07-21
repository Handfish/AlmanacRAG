// Test fixtures modeled field-for-field on the real ce-catalog detail markup
// (a <table> of <td><strong>Label</strong></td><td>value</td> rows, multi-label
// Course ID / Section ID cell, "$ n" | label fee rows, and the "More offerings
// like this" grouping anchor). Parametric so change-detection tests can flip a
// single field.

export interface DetailOpts {
  readonly title?: string;
  readonly status?: string;
  readonly courseId?: string;
  readonly sectionId?: string;
  readonly session?: string;
  readonly dates?: string;
  readonly instructor?: string;
  readonly description?: string;
  readonly fee?: string;
  readonly groupHref?: string;
}

const DEFAULT_DESC =
  "In this session, we will focus on building elementary math teachers' skills in "
  + "multiplying and dividing fractions. We will focus on how to teach the fraction "
  + "operations of multiplication and division for deep understanding.";

export const detailHtml = (opts: DetailOpts = {}): string =>
  `<!doctype html>
<html>
<head><title>${opts.title ?? "Elementary Math: Teaching Multiplication and Division"}</title></head>
<body>
<div id="nav">Global nav that is identical on every page — chrome, not content.</div>
<div role="main">
  <h1>${opts.title ?? "Elementary Math: Teaching Multiplication and Division"}</h1>
  <p>Mathematics Science and Computer Education</p>
  <p>${opts.description ?? DEFAULT_DESC}</p>
  <table>
    <tr><td valign="top"><strong>Status</strong></td>
        <td colspan="2"><span class="body">${
    opts.status ?? "Registration Available"
  }</span></td></tr>
    <tr><td valign="top"><strong>Course ID</strong><br><strong>Section ID</strong></td>
        <td valign="top">${opts.courseId ?? ""}<br>${opts.sectionId ?? "MathSeries-94"}</td></tr>
    <tr><td valign="top"><strong>Session</strong></td><td>${
    opts.session ?? "Fall- 2026"
  }&nbsp;</td></tr>
    <tr><td valign="top"><strong>Days</strong></td><td>Th&nbsp;</td></tr>
    <tr><td valign="top"><strong>Dates</strong></td><td>${
    opts.dates ?? "Thursday, October 29, 2026"
  }&nbsp;</td></tr>
    <tr><td valign="top"><strong>Instructor</strong></td><td colspan="2">${
    opts.instructor ?? "Teehan, Kare"
  }&nbsp;</td></tr>
    <tr><td valign="top"><strong>Location</strong></td><td colspan="2">On-line, N/A, N/A&nbsp;</td></tr>
    <tr><td valign="top"><strong>Course<br>Prerequisites</strong></td><td colspan="2">None</td></tr>
    <tr><td valign="top"><strong>Audience</strong></td><td colspan="2">Elementary Teachers</td></tr>
    <tr><td valign="top"><strong>Refund Policy</strong></td>
        <td colspan="2"><p>Refunds not available for no-shows. If you are unable to attend and notify
        staff 24 hrs. prior to event, you have the option of attending another workshop.</p></td></tr>
    <tr><td colspan="2" class="info"><strong>Fee(s)</strong></td><td class="info">&nbsp;</td></tr>
    <tr><td width="120">$ ${opts.fee ?? "149"}</td><td colspan="2">Registration Fee</td></tr>
    <tr><td width="120">$ ${opts.fee ?? "149"}</td><td colspan="2">Total Fees</td></tr>
  </table>
  <a href="${
    opts.groupHref ?? "searchResults.cfm?couID=30092"
  }"><img title="More offerings like this." alt="More offerings like this." src="images/search.gif"></a>
</div>
<div id="footer">Identical footer boilerplate on every page.</div>
</body>
</html>`;

export const indexHtml = (schIds: ReadonlyArray<number>): string =>
  `<!doctype html>
<html><body><div role="main">
<h1>Search Results</h1>
${
    schIds.map((id) => `<a href="courseDisplay.cfm?schID=${id}" class="chart">Course ${id}</a>`)
      .join("\n")
  }
<a href="search.cfm">New Search</a>
</div></body></html>`;
