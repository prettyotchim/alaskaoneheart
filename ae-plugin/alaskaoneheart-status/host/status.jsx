// What is open in After Effects, as a JSON string for main.js (ExtendScript is ES3: no JSON object, no let/const)
function aohStatus() {
    function q(v) {
        return '"' + String(v).replace(/[\\"]/g, function (c) { return '\\' + c; }).replace(/[\u0000-\u001f]/g, ' ') + '"';
    }
    var project = 'Untitled Project', comp = '', layers = 0, rendering = false, queued = 0, active = 0, i, rq, it;
    try { if (app.project.file) project = app.project.file.displayName; } catch (e) {}
    try {
        it = app.project.activeItem;
        if (it && it instanceof CompItem) { comp = it.name; layers = it.numLayers; }
    } catch (e) {}
    try {
        rq = app.project.renderQueue;
        rendering = rq.rendering;
        if (rendering) {
            for (i = 1; i <= rq.numItems; i++) {
                if (rq.item(i).status === RQItemStatus.QUEUED) queued++;
                else if (rq.item(i).status === RQItemStatus.RENDERING) active++;
            }
        }
    } catch (e) {}
    return '{"project":' + q(project) + ',"comp":' + q(comp) + ',"layers":' + layers + ',"rendering":' + (rendering ? 'true' : 'false') +
        ',"queued":' + queued + ',"active":' + active + '}';
}
