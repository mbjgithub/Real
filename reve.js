'use strict';

var $ = require('./lib/dm')
var util = require('./lib/util')
var conf = require('./lib/conf')
var is = require('./lib/is')
var Query = require('./lib/query')
var consoler = require('./lib/consoler')
var KP = require('./lib/keypath')
var buildInDirectives = require('./lib/build-in')
var Expression = require('./lib/expression')
var supportQuerySelector = require('./lib/detection').supportQuerySelector
var _execute = require('./lib/execute')
var _components = {}
var _globalDirectives = {}
var _isExpr = Expression.isExpr
var _strip = Expression.strip
var _did = 0
var _diff = function () {
    return util.diff.apply(util, arguments)
}

/**
 * Constructor Function and Class.
 * @param {Object} options Instance options
 * @return {Object} Reve component instance
 */
function Reve(options) {
    var vm = this
    var NS = conf.namespace
    var _ready = options.ready
    var _created = options.created
    var _binding = util.hasOwn(options, 'binding') ? options.binding : true
    var $directives = this.$directives = []
    var $components = this.$components = []
    this.$parent = options.parent || null
    this.$binding = _binding
    this.$shouldUpdate = options.shouldUpdate

    /**
     * Update bindings, binding option can enable/disable
     */
    this.$update = function (updId/*updIds*/, handler) {

        if (updId && updId.length) {
            var multi = util.type(updId) == 'array' ?  true:false
            var updateHandler = function(t) {
                return function (c) {
                    if (multi && !~updId.indexOf(c.$updateId)) return
                    else if (!multi && c.$updateId !== updId) return

                    if (util.type(handler) == 'function') {
                        handler.call(c, t, c.$updateId) && c.$update()
                    } else {
                        c.$update()
                    }
                }
            }
            util.forEach($components, updateHandler('component'))
            return util.forEach($directives, updateHandler('directive'))
        }
        // update child components
        util.forEach($components, function (c) {
            if(c.$binding) {
                c.$componentUpdate 
                    ? c.$componentUpdate() 
                    : c.$update()
            }
        })
        // update directive of the VM
        util.forEach($directives, function (d) {
            d.$update()
        })
    }

    var el = options.el
    /**
     *  Mounted element detect
     */
    if (el && options.template) {
        var hasReplaceOption = _hasAttribute(el, NS + 'replace')
            ? _getAttribute(el, NS + 'replace') == 'true'
            : options.replace

        if (hasReplaceOption && el.parentNode) {
            var child = _fragmentWrap(options.template)
            if (!child.children.length) throw new Error('Component with \'' + NS + 'replace\' must has a child element of template.', options.template)
            var nextEl =child.children[0]
            var parent = el.parentNode
            parent.replaceChild(nextEl, el)
            _cloneArributes(el, nextEl)
            el = nextEl
        } else {
            if (hasReplaceOption && !el.parentNode) {
                consoler.warn('Invalid element with \'' + NS + 'replace\' option.', el)
            }
            el.innerHTML = options.template
        }
    } else if (options.template) {
        if (options.replace) {
            el = _fragmentWrap(options.template).children[0]
            !el && consoler.warn('Component\'s template should has a child element when using \'replace\' option.', options.template)
        }
        if (!el) {
            el = document.createElement('div')
            el.innerHTML = options.template
        }
    } else if (util.type(el) == 'string') {
        var sel = el
        if (supportQuerySelector)
            el = document.querySelector(sel)
        else if (/^\./.test(sel)) {
            el = _getElementsByClassName(sel.replace(/^\./, ''))
            el && (el = el[0])
        }
        else if (/^#/.test(sel))
            el = document.getElementById(sel.replace(/^#/, ''))
        else el = null
        if (!el) return consoler.error('Can\'t not found element by selector "' + sel + '"')
    } else if (!is.Element(el)) {
        throw new Error('Unmatch el option')
    }

    this.$el = el
    this.$methods = {}
    this.$data = (util.type(options.data) == 'function' ? options.data():options.data) || {}
    this.$refs = {}

    util.objEach(options.methods, function (key, m) {
        vm.$methods[key] = vm[key] =util.bind(m, vm)
    })

    _created && _created.call(vm)

    this.$compile(el)
    _ready && _ready.call(vm)
}
Reve.prototype.$set = function (/*[keypath, ]*/value) {
    var keypath = util.type(value) == 'string' ? value : ''
    if (keypath) {
        value = arguments[1]
        KP.set(this.$data, keypath, value)
    } else {
        this.$data = util.extend(this.$data, value)
    }
    this.$update()
}
/**
 * Get root component instance of the ViewModel
 */
Reve.prototype.$root = function () {
    var parent = this
    while(parent.$parent) {
        parent = parent.$parent 
    }
    return parent || null
}
/**
 * Compile all directives of the HTMLElement or HTML template in current ViewModel. 
 * It's useful when load something async then append to current ViewModel's DOM Tree.
 * @param  {Element} | {String} el The HTMLElement of HTML template need to compile
 * @return {Element} | {DocumentFragment}
 */
Reve.prototype.$compile = function (el) {
    if (util.type(el) == 'string') el = _fragmentWrap(el)

    var NS = conf.namespace
    var $directives = this.$directives
    var $components = this.$components
    var componentDec = NS + 'component'
    var componentSel = '[' + componentDec + ']'
    var vm = this
    // compile directives of the VM
    var _diretives = util.extend({}, buildInDirectives, _globalDirectives)
    var attSels = util.keys(_diretives)
    var querySelectorAll = Query(el, componentDec, util.map(attSels, function (sel) {
            return conf.namespace + sel
        }))
    if (supportQuerySelector) {
        // nested component
        var grandChilds = util.slice(el.querySelectorAll(componentSel + ' ' + componentSel))
    }
    var childs = util.slice(querySelectorAll(componentSel))

    // compile components
    util.forEach(childs, util.bind(function (tar) {
        // prevent cross level component parse and repeat parse
        if (tar._component) return
        if (supportQuerySelector && ~util.indexOf(grandChilds, tar)) return

        var cname = _getAttribute(tar, componentDec)
        if (!cname) {
            return consoler.error(componentDec + ' missing component id.')
        }
        var Component = _components[cname]
        if (!Component) {
            return consoler.error('Component \'' + cname + '\' not found.')
        }

        var refid = _getAttribute(tar, NS + 'ref')
        var cdata = _getAttribute(tar, NS + 'data')
        var cmethods = _getAttribute(tar, NS + 'methods')
        var bindingOpt = _getAttribute(tar, NS + 'binding')
        var updId = _getAttribute(tar, NS + 'updateid') || ''
        var data = {}
        var methods = {}
        var preData

        // remove 'r-component' attribute
        _removeAttribute(tar, componentDec)

        util.forEach(['ref','data', 'methods', 'binding'], function (a) {
            _removeAttribute(tar, NS + a)
        })

        if (cdata) {
            data = _execLiteral(cdata, this, NS + 'data')            
            preData = util.immutable(data)
        }
        if (cmethods) {
            methods = _execLiteral(cmethods, this, NS + 'methods')
        }
        tar._component = componentDec
        var c = new Component({
            el: tar,
            data: data,
            parent: vm,
            methods: methods,
            binding: (bindingOpt === 'false' || bindingOpt === '0') ? false : true
        })
        // for component inspecting
        tar.setAttribute('data-rcomponent', cname)

        if (refid) {
            this.$refs[refid] = c
        }
        c.$updateId = updId || ''
        /**
         * Hook component instance update method, sync passing data before update.
         * @type {[type]}
         */
        var _$update = c.$update
        c.$componentUpdate = function () {
            var shouldUpdate = this.$shouldUpdate
            var nextData = _execLiteral(cdata, vm)
            // no cdata binding will not trigger update
            if (cdata && util.diff(preData, nextData)) {
                // should update return false will stop continue UI update
                if (shouldUpdate && !shouldUpdate.call(c, nextData, preData)) return
                preData = util.immutable(nextData)
                // merge updated data
                c.$data = util.extend(c.$data, nextData)
                _$update && _$update.apply(c, arguments)
            }
        }
        $components.push(c)

    }, this))

    util.forEach(util.keys(_diretives), function (dname) {

        var def = _diretives[dname]
        dname = NS + dname
        var bindingDrts = util.slice(querySelectorAll('[' + dname + ']'))
        // compile directive of container 
        if (_hasAttribute(el, dname)) bindingDrts.unshift(el)

        util.forEach(bindingDrts, function (tar) {

            var drefs = tar._diretives || []
            var expr = _getAttribute(tar, dname) || ''
            // prevent repetitive binding
            if (drefs && ~util.indexOf(drefs, dname)) return
            _removeAttribute(tar, dname)

            var sep = conf.directiveSep
            var d
            if (def.multi && expr.match(sep)) {
                // multiple defines expression parse
                util.forEach(
                    _strip(expr).split(sep), 
                    function(item) {
                        // discard empty expression 
                        if (!util.trim(item)) return
                        d = new Directive(vm, tar, def, dname, '{' + item + '}')
                    })
            } else {
                d = new Directive(vm, tar, def, dname, expr)
            }
            $directives.push(d)
            drefs.push(dname)
            tar._diretives = drefs
        })
    })

    return el
}
/**
 * Append child ViewModel to parent VideModel
 * @param  {Reve} parent            Parent container ViewModel
 * @param  {Function} appendHandler Custom append function
 */
Reve.prototype.$appendTo = function (parent, appendHandler) {
    if (!parent || !parent.$el) 
        throw new Error('Unvalid parent viewmodel instance.')

    this.$parent = parent
    appendHandler = appendHandler || function (currNode, parentNode) {
        parentNode.appendChild(currNode)
    }
    appendHandler.call(this, this.$el, parent.$el)
}
/**
 * Create Reve subc-lass that inherit Reve
 * @param {Object} options Reve instance options
 * @return {Function} sub-lass of Reve
 */
function Ctor (options) {
    var baseMethods = options.methods
    function Class (opts) {
        var baseData = options.data ? options.data() : {}
        var instanOpts = util.extend({}, options, opts)
        util.type(instanOpts.data) == 'function' && (instanOpts.data = instanOpts.data())  
        instanOpts.methods = util.extend({}, baseMethods, instanOpts.methods)
        instanOpts.data = util.extend({}, baseData, instanOpts.data)
        Reve.call(this, instanOpts)
    }
    Class.prototype = Reve.prototype
    return Class
}
Reve.create = function (options) {
    return Ctor(options)
}
Reve.component = function (id, options) {
    var c = Ctor(options)
    _components[id] = c
    return c
}
Reve.directive = function (id, def) {
    _globalDirectives[id] = def
}

/**
 * Abstract direcitve
 * @param {Reve}    vm      Reve instance
 * @param {Element} tar     Target DOM of the direcitve
 * @param {Object}  def     Directive definition
 * @param {String}  name    Attribute name of the directive
 * @param {String}  expr    Attribute value of the directive
 */
function Directive(vm, tar, def, name, expr) {
    var d = this
    var bindParams = []
    var isExpr = !!_isExpr(expr)

    isExpr && (expr = _strip(expr))

    if (def.multi) {
        // extract key and expr from "key: expression" format
        var key
        var keyRE = /^[^:]+:/
        if (!keyRE.test(expr)) {
            return consoler.error('Invalid expression of "{' + expr + '}", it should be in this format: ' + name + '="{ key: expression }".')
        }
        expr = expr.replace(keyRE, function(m) {
            key = util.trim(m.replace(/:$/, ''))
            return ''
        })
        expr = util.trim(expr)

        bindParams.push(key)
    }

    d.$el = tar
    d.$vm = vm
    d.$id = _did++
    d.$expr = expr
    d.$name = name
    // updateId is used to update directive/component which DOM match the "updateid"
    d.$updateId = _getAttribute(tar, conf.namespace + 'updateid') || ''

    var bind = def.bind
    var upda = def.update
    var shouldUpdate = def.shouldUpdate
    var prev

    // set properties
    util.objEach(def, function(k, v) {
        d[k] = v
    })

    /**
     *  execute wrap with directive name and current VM
     */
    var _exec = this.$exec = function (expr) {
        return _execute(vm, expr, name)
    }
    this.$diff = _diff
    /**
     *  update handler
     */
    function _update() {
        // empty expression also can trigger update, such `r-text` directive
        if (!isExpr) {
            if (shouldUpdate && shouldUpdate.call(d)) {
                upda && upda.call(d)
            }
            return
        }

        var nexv = _exec(expr) // [error, result]
        var r = nexv[1]
        if (!nexv[0] && util.diff(r, prev)) {
            // shouldUpdate(nextValue, preValue)
            if (shouldUpdate && !shouldUpdate.call(d, r, prev)) {
                return false
            }
            var p = prev
            prev = r
            // update(nextValue, preValue)
            upda && upda.call(d, r, p)
        }
    }

    /**
     *  If expression is a string iteral, use it as value
     */
    var hasError
    if (isExpr) {
        prev =  _exec(expr)
        hasError = prev[0]
        prev = prev[1]
    } else {
        prev = expr
    }
    bindParams.push(prev)
    bindParams.push(expr)
    d.$update = _update

    // bind([propertyName, ]expression-value, expression) 
    // propertyName only be passed when "multi:true"
    bind && bind.apply(d, bindParams)
    // error will stop update
    !hasError && upda && upda.call(d, prev)
}

function _execLiteral (expr, vm, name) {
    if (!_isExpr(expr)) return {}
    var r = _execute(vm, expr.replace(new RegExp(conf.directiveSep, 'g'), ',').replace(/,\s*}$/, '}'), name) 
    return r[0] ? {} : r[1]
}
function _getAttribute (el, an) {
    return el && el.getAttribute(an)
}
function _hasAttribute (el, an) {
    if (el.hasAttribute) return el.hasAttribute(an)
    return el.getAttribute(an) !== null
}
function _removeAttribute (el, an) {
    return el && el.removeAttribute(an)
}
function _cloneArributes(el, target) {
    var attrs = util.slice(el.attributes)
    util.forEach(attrs, function (att) {
        if (att.name == 'class') {
            target.className = target.className + (target.className ? ' ' : '') + att.value
        } else {
            target[att.name] = att.value
        }
    })
    return target
}
function _fragmentWrap (html) {
    var div = document.createElement('div')
    var frag = document.createDocumentFragment();
    div.innerHTML = html
    var children = div.childNodes;
    while(children.length){
        frag.appendChild(children[0]);
    }
    return frag
}
function _getElementsByClassName(search) {
    if (document.getElementsByClassName) return document.getElementsByClassName(search)
    else {
        /**
         * @author eikes
         * @ref https://gist.github.com/eikes/2299607
         */
        var d = document, elements, pattern, i, results = []
        if (d.querySelectorAll) { // IE8
            return d.querySelectorAll("." + search)
        }
        if (d.evaluate) { // IE6, IE7
            pattern = ".//*[contains(concat(' ', @class, ' '), ' " + search + " ')]"
            elements = d.evaluate(pattern, d, null, 0, null)
            while ((i = elements.iterateNext())) {
                results.push(i)
            }
        } else {
            elements = d.getElementsByTagName("*")
            pattern = new RegExp("(^|\\s)" + search + "(\\s|$)")
            for (i = 0; i < elements.length; i++) {
                if ( pattern.test(elements[i].className) ) {
                    results.push(elements[i])
                }
            }
        }
        return results;
    }
}

Reve.$ = $
Reve.util = util
module.exports = Reve
