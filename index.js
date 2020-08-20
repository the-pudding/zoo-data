/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */

// process.env.DEBUG='pw:api'

const { firefox } = require('playwright');
const GIFEncoder = require('gif-encoder-2')
const {createCanvas, Image} = require('canvas')
const fs = require('fs')
const knox = require('knox')
const d3 = require('d3-dsv')

const dataName = 'gifs.json'
const data = []

const filePathImages = 'zoo-cams/temp'
const filePathGIF = 'zoo-cams/output'
const frameCount = 15
const frameRange = [...Array(frameCount).keys()]

let allScreenshots = []

let videoDimensions = {
	width: 0,
	height: 0
}

const {AWS_KEY, AWS_KEY_SECRET, AWS_BUCKET} = process.env

const client = knox.createClient({
	key: AWS_KEY,
	secret: AWS_KEY_SECRET,
	bucket: AWS_BUCKET
})


let page = null


async function createGif(algorithm, id) {
	return new Promise(async resolve1 => {
		//  there will always be the same range of image number files
		// so just iterate and create an array of numbers
		console.log(`Creating ${id} gif`)
		const imageRange = [...Array(frameCount).keys()].map((d) => `${filePathImages}/${id}/${d}.png`)
  
		const [width, height] = await new Promise((resolve2, reject2) => {

			// get the file and metadata from s3 without loading it
			client.getFile(`${filePathImages}/${id}/0.png`, (err, res) => {
				resolve2([res.headers['x-amz-meta-width'], res.headers['x-amz-meta-height']])
			})

		})

		const canvasWidth = 500
		const canvasHeight = 281
		
  
		const encoder = new GIFEncoder(canvasWidth, canvasHeight, algorithm)
	
		const canvas = createCanvas(canvasWidth, canvasHeight)
		const ctx = canvas.getContext('2d')
		encoder.start()
		encoder.setDelay(200)

		async function processImage(file){
			await new Promise(resolveProc => {
				console.log(file)
				// wrap this in a promise?
				const image = new Image()
				image.onload = () => {
					ctx.drawImage(image, 0, 0, width, height, // source dimensions
						0, 0, canvasWidth, canvasHeight)

					ctx.getImageData(0, 0, width, height)
					console.log('added')

					encoder.addFrame(ctx)
					resolveProc()
				
				}
				image.src = `https://${AWS_BUCKET}.s3.amazonaws.com/${file}`

			})
			
			return encoder
		}


		  async function orderImages(){
			  const completed = []
			  for (const file of imageRange){
				completed.push(processImage(file))
			  }

			  await Promise.all(completed).then(() => {
				encoder.finish()
				const buffer = encoder.out.getData()

				const req = client.put(`${filePathGIF}/${id}.gif`, {
					'Content-Type': 'image/gif',
				})

				req.on('response', (res) => {
					if (res.statusCode === 200){
						console.log('saved to %s', req.url)
					}
				})

				req.end(buffer)
				resolve1()
			  })
		  }

		  await orderImages()
		
	})
	
}


async function collectData(cam){
	const timestamp = Date.now()
	cam.timestamp = timestamp

	const string = JSON.stringify(cam)

	data.push(string)
}

function timeout(ms){
	return new Promise(resolve => setTimeout(resolve, ms))
}


async function sendToS3(ss, id, frame){

	return new Promise((resolve, reject) => {
		// write screenshot to AWS
		const req = client.put(`${filePathImages}/${id}/${frame}.png`, {
			'Content-Type': 'image/png',
			'x-amz-meta-height': videoDimensions.height,
			'x-amz-meta-width': videoDimensions.width
		})

		const response = req.on('response', (res) => {
			if (res.statusCode === 200){
				console.log('saved to %s', req.url)
				resolve(res)
				
			}
		})

		req.end(ss)
	})


}

async function takeScreenshots(element, id){
	// eslint-disable-next-line no-restricted-syntax
	for (const frame of frameRange){
	
		// eslint-disable-next-line no-await-in-loop
		const ss = await element.screenshot({path: ''}).catch((e) => {
			console.error(e); 
			return('') })

		// save all ss data locally 
		allScreenshots.push({index: frame, ss})
	}

	// then one by one save images to s3 in parallel
	const savedScreenshots = allScreenshots.map((single) => new Promise(async (resolve3) => {
		const {ss, index} = single
		// measure video dimensions only on first screenshot
		if (index === 0){
			videoDimensions =  await element.evaluate(() => ({
				width: document.documentElement.clientWidth,
				height: document.documentElement.clientHeight
			}))
		}

	
		 await sendToS3(ss, id, index)
		 resolve3()
	}))

	// when all screenshots have been saved, create a gif
	Promise.all(savedScreenshots).then(() => {
		console.log(`Saved all screenshots for ${id}`)
		createGif('neuquant', id)
		allScreenshots = []
	})
	
}


async function screenshot(cam) {
	const {url, id, play} = cam
	console.log(`Preparing ${id} for screenshot`)

	// navigate to URL
	await page.goto(url).catch((e) => {console.error(e)})

	// if there's a play button, click it
	if (play) {
		const buttons = play.split(', ')
		buttons.forEach(async d => {
			await page.click(`${d}`).catch((e) => console.error(e))
		})
	}


	// wait for video
	await page.waitForSelector('video').catch((e) => {console.error(e)})

	const element = await page.$('video').catch((e) => {console.error(e)})

	if (element){
		// after video has loaded, then record data
		await collectData(cam) 
		
		await timeout(5000)
		// find out if video is paused
		let paused = await element.evaluate(vid => vid.paused).catch((e) => {console.error(e)})

		// if it's still paused, click the page and wait 10 seconds before checking again
		if (paused === true) {
			await page.click('body').catch((e) => {console.error(e)})	
			await timeout(10000)
		}

		// check again
		paused = await element.evaluate(vid => vid.paused).catch((e) => {console.error(e)})
		
		// if video is playing, start taking screenshots
		// otherwise move on to the next video
		if (paused !== true ){
			await takeScreenshots(element, id)
		}
	}

}

async function writeData(){
	fs.writeFile(dataName, data, err => {
		if (err) return console.error('File write error:', err)
	})
}

async function getZoos(){
	const webcams = d3.csvParse(fs.readFileSync('zoos.csv', 'utf-8'))
	const sample = webcams.slice(5, 8)

	// launch a single browser
	const browser = await firefox.launch({headless: true,  args: ['--no-sandbox'] })

	// launch a single page 
	page = await browser.newPage()
	// set a timeout for the page of 10 seconds
	page.setDefaultTimeout(10000)

	for (const cam of sample){
		await screenshot(cam)
	}

	await browser.close()
	await writeData()

}

// run the script
getZoos()
// createGif('neuquant', 90)