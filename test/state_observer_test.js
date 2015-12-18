var assert = require('assert')
  , StateObserver = require('../lib/state/observer')
  , msgpack = require('msgpack-lite')

class PlainState {
  constructor () {
    this.integer = 1;
    this.float = Math.PI
    this.string = "Hello world"
    this.array = [1,2,3,4,5,6,7,8,9,10]
    this.objs = [{hp: 100, x: 0, y: 0}, {hp: 80, x: 10, y: 20}, {hp: 25, x: 8, y: -14}]
    this.boolean = true
  }
}

class ChildObject {
  constructor (hp, x, y, parent) {
    this.complexObject = global
    this.parent = parent
    this.hp = hp
    this.x = x
    this.y = y
  }
  toJSON () {
    return { hp: this.hp, x: this.x, y: this.y }
  }
}

class ComplexState {
  constructor () {
    this.complexObject = global
    this.integer = 1;
    this.float = Math.PI
    this.string = "Hello world"
    this.array = [1,2,3,4,5,6,7,8,9,10]
    this.objs = [
      new ChildObject(100, 0, 0, this),
      new ChildObject(80, 10, 20, this),
      new ChildObject(25, 8, -14, this)
    ]
    this.boolean = true
  }
  add(hp, x, y) {
    this.objs.push( new ChildObject(hp, x, y, this) )
  }
  toJSON () {
    return {
      integer: this.integer,
      float: this.float,
      string: this.string,
      array: this.array,
      objs: this.objs,
      boolean: this.boolean
    }
  }
}

describe('StateObserver', function() {
  describe('plain object state', function() {
    var state = new PlainState()
    var observer = new StateObserver(state)

    it('shouldn\'t have patches to apply', function() {
      assert.deepEqual(observer.getPatches(), [])
    })

    it('should have patches to apply', function() {
      state.string = "Changed!"
      var patches = observer.getPatches()
      assert.equal(patches.length, 1)
      assert.deepEqual(patches, [ { op: 'replace', path: '/string', value: 'Changed!' } ])
    })

    it('should get diff state', function() {
      var time = Date.now()
      state.array[9] = 20
      state.array.push(21)

      state.objs[2].x = 100
      state.objs.push({ hp: 80, x: 100, y: 200 })

      var diff = observer.getPatches()
      var diffTime = Date.now() - time

      assert.deepEqual(diff, [
        { op: 'replace', path: '/objs/2/x', value: 100 },
        { op: 'add', path: '/objs/3', value: { hp: 80, x: 100, y: 200 } },
        { op: 'replace', path: '/array/9', value: 20 },
        { op: 'add', path: '/array/10', value: 21 }
      ])

      assert.ok(diffTime <= 5)
    })
  })

  describe('classy object state (generated through toJSON method)', function() {
    var state = new ComplexState()
    var observer = new StateObserver(state)

    it('shouldn\'t have patches to apply', function() {
      assert.deepEqual(observer.getPatches(), [])
    })

    it('should have patches to apply', function() {
      state.string = "Changed!"
      var patches = observer.getPatches()
      assert.equal(patches.length, 1)
      assert.deepEqual(patches, [ { op: 'replace', path: '/string', value: 'Changed!' } ])
    })

    it('should get diff state', function() {
      var time = Date.now()
      state.array[9] = 20
      state.array.push(21)

      state.objs[2].x = 100
      state.add(80, 100, 200)

      var diff = observer.getPatches()
      var diffTime = Date.now() - time

      assert.deepEqual(diff, [
        { op: 'replace', path: '/objs/2/x', value: 100 },
        { op: 'add', path: '/objs/3', value: { hp: 80, x: 100, y: 200 } },
        { op: 'replace', path: '/array/9', value: 20 },
        { op: 'add', path: '/array/10', value: 21 }
      ])

      assert.ok(diffTime <= 5)
    })

  })

});
